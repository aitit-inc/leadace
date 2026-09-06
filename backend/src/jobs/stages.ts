// Runs one job kind as Workflow steps. A step is the unit that retries and
// survives hibernation, so every side effect lives inside one; what a step
// returns is what a replay sees.
import type { WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { Env } from '../api/types'
import { createDb, type Db } from '../db/connection'
import { runWithRls, withTenantConnection } from '../db/rls'
import type { ProjectId, TenantId } from '../domain/ids'
import type { DiscoverCandidate, JobParamsOf, JobResult } from '../domain/jobs'
import type { ServiceResult } from '../services/result'
import { loadJobForRun, writeJobProgress, type LoadedJob } from '../services/jobs'
import { runDiscover } from '../services/pipeline/discover'
import { runEnrich } from '../services/pipeline/enrich'
import { draftOne, loadCompositionContext, loadDraftBatch, summarizeDraftOutcomes, type DraftOutcome } from '../services/pipeline/draft'
import { runEvaluate } from '../services/pipeline/evaluate'
import { runJournal, type CycleDigest } from '../services/pipeline/journal'
import { sendDraft } from '../services/outreach'
import { editionOf, sendContextOf, type ProgressFn } from '../services/pipeline/context'

export type StageCtx = {
  env: Env
  step: WorkflowStep
  job: LoadedJob
}

export const STEP_RETRY = { retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '10 minutes' } as const
// A step that may hand a message to Gmail has no stable idempotency key across
// the provider call and the bookkeeping after it — a retry could send twice.
// sendAndRecord records its own failure; the step runs once.
export const SEND_STEP = { retries: { limit: 0, delay: '1 second' }, timeout: '10 minutes' } as const

// Upstream flakiness retries; anything the caller must fix does not.
export function unwrap<T>(r: ServiceResult<T>): T {
  if (r.ok) return r.value
  const detail = typeof r.detail === 'string' ? ` — ${r.detail}` : ''
  const message = `${r.error}${detail}`
  if (r.code === 'BAD_GATEWAY' || r.code === 'INTERNAL_ERROR') throw new Error(message)
  throw new NonRetryableError(message)
}

// Progress is advisory: a failed write must not fail the stage it reports on.
export function progressWriter(ctx: StageCtx, db: Db, prefix?: string): ProgressFn {
  return async (step, done, total) => {
    await writeJobProgress(db, ctx.job.tenantId, ctx.job.id, { step: prefix ? `${prefix}: ${step}` : step, done, total }).catch(
      (e: unknown) => console.warn(`[jobs] progress write failed job=${ctx.job.id}`, e),
    )
  }
}

type Ids = { tenantId: TenantId; projectId: ProjectId }

// DB-only step bodies run as one tenant transaction (the job path's request).
export function tenantTx<T>(ctx: StageCtx, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withTenantConnection(ctx.env.DATABASE_URL, ctx.job.tenantId, fn)
}

// A cancel that reached the row while the instance kept running: checked
// before every step that would send, so "cancelled" means no further sends.
async function isCancelled(ctx: StageCtx, db: Db): Promise<boolean> {
  const row = await loadJobForRun(db, ctx.job.tenantId, ctx.job.id)
  return row?.status === 'cancelled'
}

export async function discoverStage(
  ctx: StageCtx,
  params: JobParamsOf<'discover'>,
  namePrefix = 'discover',
): Promise<Extract<JobResult, { kind: 'discover' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  const discovered = await ctx.step.do(namePrefix, STEP_RETRY, async () => {
    const db = createDb(ctx.env.DATABASE_URL)
    return unwrap(await runDiscover(db, tenantId, ctx.env, projectId, params, progressWriter(ctx, db, 'discover')))
  })
  const enriched = await enrichStage(ctx, discovered.candidates, `${namePrefix}:enrich`)
  return {
    ...discovered.result,
    registered: enriched.registered,
    summary: `${discovered.result.summary} ${enriched.summary}`,
  }
}

const ENRICH_CHUNK = 8

export async function enrichStage(
  ctx: StageCtx,
  candidates: DiscoverCandidate[],
  namePrefix = 'enrich',
): Promise<Extract<JobResult, { kind: 'enrich' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  const totals = { registered: 0, skipped: 0, withEmail: 0, skippedDetails: [] as Array<{ name: string; reason: string }> }
  for (let i = 0; i < candidates.length; i += ENRICH_CHUNK) {
    const chunk = candidates.slice(i, i + ENRICH_CHUNK)
    const r = await ctx.step.do(`${namePrefix}:${i}`, STEP_RETRY, async () => {
      const db = createDb(ctx.env.DATABASE_URL)
      const progress: ProgressFn = (step, done) => progressWriter(ctx, db, 'enrich')(step, i + done, candidates.length)
      return unwrap(await runEnrich(db, tenantId, ctx.env, projectId, chunk, progress))
    })
    totals.registered += r.registered
    totals.skipped += r.skipped
    totals.withEmail += r.withEmail
    totals.skippedDetails.push(...r.skippedDetails)
  }
  return {
    kind: 'enrich',
    summary: candidates.length === 0 ? 'Nothing to enrich.' : `Registered ${totals.registered} of ${candidates.length} (${totals.withEmail} with email); ${totals.skipped} skipped.`,
    ...totals,
  }
}

export async function draftStage(
  ctx: StageCtx,
  params: JobParamsOf<'draft'>,
  namePrefix = 'draft',
): Promise<Extract<JobResult, { kind: 'draft' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  const batch = await ctx.step.do(`${namePrefix}:load`, STEP_RETRY, () =>
    tenantTx(ctx, async (tx) => unwrap(await loadDraftBatch(tx, tenantId, ctx.env, projectId, params))),
  )
  if (batch.targets.length === 0) return summarizeDraftOutcomes([], batch.needsHands, batch.quotaMessage)
  // Shared by every composition; its own retried step so the zero-retry send
  // step below holds nothing but the one call that must not run twice.
  const context = await ctx.step.do(`${namePrefix}:context`, STEP_RETRY, () =>
    tenantTx(ctx, async (tx) => unwrap(await loadCompositionContext(tx, tenantId, projectId))),
  )
  const outcomes: DraftOutcome[] = []
  let consecutiveFailures = 0
  for (const [i, p] of batch.targets.entries()) {
    const outcome = await ctx.step.do(`${namePrefix}:${p.prospectId}`, SEND_STEP, async (): Promise<DraftOutcome | null> => {
      const db = createDb(ctx.env.DATABASE_URL)
      if (await isCancelled(ctx, db)) return null
      await progressWriter(ctx, db, 'draft')(p.name, i, batch.targets.length)
      return draftOne(db, tenantId, ctx.env, projectId, p, batch, context)
    })
    if (outcome === null) break
    outcomes.push(outcome)
    if (outcome.kind === 'sent') await ctx.step.sleep(`${namePrefix}:space:${p.prospectId}`, '30 seconds')
    // A mailbox or quota problem fails every remaining prospect the same way;
    // three in a row is that, not three different recipients.
    consecutiveFailures = outcome.kind === 'failed' ? consecutiveFailures + 1 : 0
    if (consecutiveFailures >= 3) break
  }
  return summarizeDraftOutcomes(outcomes, batch.needsHands, batch.quotaMessage)
}

export async function sendStage(ctx: StageCtx, params: JobParamsOf<'send'>): Promise<Extract<JobResult, { kind: 'send' }>> {
  const { tenantId }: Ids = ctx.job
  let sent = 0
  let failed = 0
  const errors: string[] = []
  for (const [i, id] of params.draftIds.entries()) {
    const outcome = await ctx.step.do(`send:${id}`, SEND_STEP, async () => {
      const db = createDb(ctx.env.DATABASE_URL)
      if (await isCancelled(ctx, db)) return { ok: false as const, cancelled: true as const, error: 'job cancelled' }
      await progressWriter(ctx, db, 'send')(`draft ${id}`, i, params.draftIds.length)
      const r = await runWithRls(db, tenantId, (tx) => sendDraft(tx, tenantId, editionOf(ctx.env), sendContextOf(ctx.env), id))
      return r.ok ? { ok: true as const } : { ok: false as const, cancelled: false as const, error: r.error }
    })
    if (!outcome.ok && outcome.cancelled) break
    if (outcome.ok) {
      sent++
      await ctx.step.sleep(`send:space:${id}`, '30 seconds')
    } else {
      failed++
      errors.push(`#${id}: ${outcome.error}`)
    }
  }
  return {
    kind: 'send',
    summary: `${sent} sent, ${failed} failed.${errors.length > 0 ? ` ${errors.slice(0, 3).join('; ')}` : ''}`,
    sent,
    failed,
  }
}

export async function evaluateStage(ctx: StageCtx): Promise<Extract<JobResult, { kind: 'evaluate' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  return ctx.step.do('evaluate', STEP_RETRY, async () => {
    const db = createDb(ctx.env.DATABASE_URL)
    return unwrap(await runEvaluate(db, tenantId, ctx.env, projectId, progressWriter(ctx, db, 'evaluate')))
  })
}

export async function journalStage(ctx: StageCtx, digest: CycleDigest | null): Promise<Extract<JobResult, { kind: 'journal' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  return ctx.step.do('journal', STEP_RETRY, async () => {
    const db = createDb(ctx.env.DATABASE_URL)
    return unwrap(await runJournal(db, tenantId, ctx.env, projectId, digest, progressWriter(ctx, db, 'journal')))
  })
}
