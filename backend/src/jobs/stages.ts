// Runs one job kind as Workflow steps. A step is the unit that retries and
// survives hibernation, so every side effect lives inside one; what a step
// returns is what a replay sees.
import type { WorkflowStep } from 'cloudflare:workers'
import { NonRetryableError } from 'cloudflare:workflows'
import type { Env } from '../api/types'
import { createDb, type Db } from '../db/connection'
import { withTenantConnection } from '../db/rls'
import type { ReachArm } from '../domain/cycle-plan'
import type { ProjectId, TenantId } from '../domain/ids'
import type { DiscoverCandidate, JobLogEntry, JobParamsOf, JobResult } from '../domain/jobs'
import type { ServiceResult } from '../services/result'
import { appendJobLog, loadJobForRun, writeJobProgress, type LoadedJob } from '../services/jobs'
import { kickAutoTopUp } from '../services/credits'
import { runDiscover } from '../services/pipeline/discover'
import { runEnrich } from '../services/pipeline/enrich'
import { draftLogEntry, draftOne, loadDraftBatch, refillDrawSize, summarizeDraftOutcomes, type DraftOutcome } from '../services/pipeline/draft'
import { runEvaluate } from '../services/pipeline/evaluate'
import { runJournal, type CycleDigest } from '../services/pipeline/journal'
import { sendDraft, wasSentSince } from '../services/outreach'
import { withPaidCallScope } from '../services/paid-calls'
import { editionOf, sendContextOf, type Checkpoint, type ProgressFn } from '../services/pipeline/context'

export type StageCtx = {
  env: Env
  step: WorkflowStep
  job: LoadedJob
}

// A step callback runs outside the Workflow's async context, so the paid
// call scope is entered per step.
function paidScoped<T>(ctx: StageCtx, fn: () => Promise<T>): Promise<T> {
  return withPaidCallScope({ databaseUrl: ctx.env.DATABASE_URL, tenantId: ctx.job.tenantId, projectId: ctx.job.projectId, jobId: ctx.job.id }, fn)
}

// 30 minutes: well above a step's real bound, the timeouts of the few LLM
// calls inside it. Workflows charges CPU, not wall clock, so a wider window
// only delays noticing a stuck step.
export const STEP_RETRY = { retries: { limit: 2, delay: '20 seconds', backoff: 'exponential' }, timeout: '30 minutes' } as const

// Upstream flakiness retries; anything the caller must fix does not.
export function unwrap<T>(r: ServiceResult<T>): T {
  if (r.ok) return r.value
  const detail = typeof r.detail === 'string' ? ` — ${r.detail}` : ''
  const message = `${r.error}${detail}`
  if (r.code === 'BAD_GATEWAY' || r.code === 'INTERNAL_ERROR') throw new Error(message)
  throw new NonRetryableError(message)
}

// Each unit of a stage is its own step, so a restart redoes one unit.
function checkpointOf(ctx: StageCtx, prefix: string): Checkpoint {
  return (name, fn) => ctx.step.do(`${prefix}:${name}`, STEP_RETRY, () => paidScoped(ctx, async () => unwrap(await fn())))
}

// Progress is advisory: a failed write must not fail the stage it reports on.
export function progressWriter(ctx: StageCtx, db: Db, prefix?: string): ProgressFn {
  return async (step, done, total) => {
    await writeJobProgress(db, ctx.job.tenantId, ctx.job.id, { step: prefix ? `${prefix}: ${step}` : step, done, total }).catch(
      (e: unknown) => console.warn(`[jobs] progress write failed job=${ctx.job.id}`, e),
    )
  }
}

// A failed write must not fail the step that did the work.
async function writeLog(ctx: StageCtx, db: Db, stepName: string, entries: JobLogEntry[]): Promise<void> {
  await appendJobLog(db, ctx.job.tenantId, ctx.job.id, stepName, entries).catch((e: unknown) =>
    console.warn(`[jobs] log write failed job=${ctx.job.id}`, e),
  )
}

// For entries known outside any step (the daily cycle's decisions): a step of
// their own, so a replay after hibernation does not write them twice.
export async function logStep(ctx: StageCtx, name: string, entries: JobLogEntry[]): Promise<void> {
  const stepName = `log:${name}`
  await ctx.step.do(stepName, async () => {
    await writeLog(ctx, createDb(ctx.env.DATABASE_URL), stepName, entries)
    return true
  })
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
  const db = createDb(ctx.env.DATABASE_URL)
  const discovered = unwrap(await runDiscover(db, tenantId, ctx.env, projectId, params, checkpointOf(ctx, namePrefix), progressWriter(ctx, db, 'discover')))
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
  const totals = { registered: 0, skipped: 0, withEmail: 0 }
  for (let i = 0; i < candidates.length; i += ENRICH_CHUNK) {
    const chunk = candidates.slice(i, i + ENRICH_CHUNK)
    const stepName = `${namePrefix}:${i}`
    const db = createDb(ctx.env.DATABASE_URL)
    const progress: ProgressFn = (step, done) => progressWriter(ctx, db, 'enrich')(step, i + done, candidates.length)
    const { log, withEmail } = unwrap(await runEnrich(db, tenantId, ctx.env, projectId, chunk, checkpointOf(ctx, stepName), progress))
    await logStep(ctx, stepName, log)
    const registered = log.filter((l) => l.kind === 'prospect' && l.outcome === 'registered').length
    totals.registered += registered
    totals.skipped += log.length - registered
    totals.withEmail += withEmail
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
  arm?: ReachArm,
  // Shared across calls that must not draw the same prospect twice; each call
  // appends the prospects it tries.
  attempted: number[] = [],
): Promise<Extract<JobResult, { kind: 'draft' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  const wanted = params.prospectIds?.length ?? params.count ?? 30
  const triedBefore = attempted.length
  const load = (round: number, limit: number) =>
    ctx.step.do(`${namePrefix}:load:${round}`, STEP_RETRY, () =>
      tenantTx(ctx, async (tx) => unwrap(await loadDraftBatch(tx, tenantId, ctx.env, projectId, params, { limit, excludeProspectIds: attempted, arm }))),
    )
  let batch = await load(1, wanted)
  if (batch.targets.length === 0) return summarizeDraftOutcomes([], batch.needsHands, batch.quotaMessage)
  const outcomes: DraftOutcome[] = []
  const needsHands = batch.needsHands
  let quotaMessage = batch.quotaMessage
  let produced = 0
  let consecutiveFailures = 0
  rounds: for (let round = 2; ; round++) {
    for (const p of batch.targets) {
      const stepName = `${namePrefix}:${p.prospectId}`
      const done = produced
      attempted.push(p.prospectId)
      const outcome = await ctx.step.do(stepName, STEP_RETRY, () => paidScoped(ctx, async (): Promise<DraftOutcome | null> => {
        const db = createDb(ctx.env.DATABASE_URL)
        if (await isCancelled(ctx, db)) return null
        await progressWriter(ctx, db, 'draft')(p.name, done, wanted)
        const drafted = unwrap(await draftOne(db, tenantId, ctx.env, projectId, p.prospectId, new Date(ctx.job.createdAt)))
        await writeLog(ctx, db, stepName, [draftLogEntry(p.name, drafted)])
        return drafted
      }))
      if (outcome === null) break rounds
      outcomes.push(outcome)
      if (outcome.kind === 'sent' || outcome.kind === 'drafted') produced++
      if (outcome.kind === 'sent') await ctx.step.sleep(`${namePrefix}:space:${p.prospectId}`, '30 seconds')
      // A mailbox or quota problem fails every remaining prospect the same way;
      // three in a row is that, not three different recipients.
      consecutiveFailures = outcome.kind === 'failed' && outcome.at === 'send' ? consecutiveFailures + 1 : 0
      if (consecutiveFailures >= 3) break rounds
    }
    // An explicit list is the batch itself; a count is refilled until that
    // many messages are out.
    const limit = params.prospectIds ? 0 : refillDrawSize(wanted, produced, attempted.length - triedBefore)
    if (limit === 0) break
    batch = await load(round, limit)
    quotaMessage = batch.quotaMessage ?? quotaMessage
    if (batch.targets.length === 0) break
  }
  return summarizeDraftOutcomes(outcomes, needsHands, quotaMessage)
}

export async function sendStage(ctx: StageCtx, params: JobParamsOf<'send'>): Promise<Extract<JobResult, { kind: 'send' }>> {
  const { tenantId }: Ids = ctx.job
  let sent = 0
  let failed = 0
  const errors: string[] = []
  for (const [i, id] of params.draftIds.entries()) {
    const outcome = await ctx.step.do(`send:${id}`, STEP_RETRY, () => paidScoped(ctx, async () => {
      const db = createDb(ctx.env.DATABASE_URL)
      if (await isCancelled(ctx, db)) return { ok: false as const, cancelled: true as const, error: 'job cancelled' }
      await progressWriter(ctx, db, 'send')(`draft ${id}`, i, params.draftIds.length)
      const r = await sendDraft((fn) => tenantTx(ctx, fn), tenantId, editionOf(ctx.env), sendContextOf(ctx.env), id)
      // A rerun finds the draft this job already sent.
      if (!r.ok && r.code === 'CONFLICT' && (await tenantTx(ctx, (tx) => wasSentSince(tx, tenantId, id, new Date(ctx.job.createdAt))))) {
        return { ok: true as const }
      }
      if (r.ok) await kickAutoTopUp(ctx.env, tenantId)
      return r.ok ? { ok: true as const } : { ok: false as const, cancelled: false as const, error: r.error }
    }))
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
  return ctx.step.do('evaluate', STEP_RETRY, () => paidScoped(ctx, async () => {
    const db = createDb(ctx.env.DATABASE_URL)
    return unwrap(await runEvaluate(db, tenantId, ctx.env, projectId, progressWriter(ctx, db, 'evaluate')))
  }))
}

export async function journalStage(ctx: StageCtx, digest: CycleDigest | null): Promise<Extract<JobResult, { kind: 'journal' }>> {
  const { tenantId, projectId }: Ids = ctx.job
  return ctx.step.do('journal', STEP_RETRY, () => paidScoped(ctx, async () => {
    const db = createDb(ctx.env.DATABASE_URL)
    return unwrap(await runJournal(db, tenantId, ctx.env, projectId, digest, progressWriter(ctx, db, 'journal')))
  }))
}
