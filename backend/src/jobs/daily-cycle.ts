// The daily cycle (daily-cycle/SKILL.md, server-side): evaluate → lever tick →
// outbound → prospect discovery when the list runs low → journal → report.
// Each stage is the same code a standalone job runs; this file only decides
// the order and the counts.
import { NonRetryableError } from 'cloudflare:workflows'
import { and, eq } from 'drizzle-orm'
import { tenantMembers } from '../db/schema'
import type { JobParamsOf, JobResult } from '../domain/jobs'
import { shouldBuildFirst, type ReachableSnapshot } from '../domain/cycle-plan'
import { runLeverTick } from '../services/levers'
import { listReachable } from '../services/prospects'
import { getActiveStrategySlugs } from '../services/discovery-strategies'
import { assertTenantComplianceReady } from '../services/tenants'
import { notifyUser } from '../services/notifications'
import { editionOf, googleCtxOf } from '../services/pipeline/context'
import type { CycleDigest } from '../services/pipeline/journal'
import { discoverStage, draftStage, evaluateStage, journalStage, STEP_RETRY, tenantTx, unwrap, type StageCtx } from './stages'

async function reachableSnapshot(ctx: StageCtx, name: string): Promise<ReachableSnapshot> {
  return ctx.step.do(name, STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const r = unwrap(await listReachable(db, ctx.job.tenantId, editionOf(ctx.env), ctx.job.projectId, { limit: 1 }))
    return {
      total: r.total,
      email: r.byChannel.email,
      formOnly: r.byChannel.formOnly,
      platformOnly: r.byChannel.platformOnly,
      blocked: r.outboundBlocked ? r.message ?? 'outbound blocked' : null,
    }
  }))
}

export async function runDailyCycle(ctx: StageCtx, params: JobParamsOf<'daily_cycle'>): Promise<Extract<JobResult, { kind: 'daily_cycle' }>> {
  const { tenantId, projectId } = ctx.job
  const stages: CycleDigest['stages'] = []
  const decisions: string[] = []

  await ctx.step.do('compliance', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const ready = await assertTenantComplianceReady(db, tenantId)
    if (!ready.ok) throw new NonRetryableError(`${ready.error}${typeof ready.detail === 'string' ? ` — ${ready.detail}` : ''}`)
    return true
  }))

  const evaluated = await evaluateStage(ctx)
  stages.push({ kind: 'evaluate', summary: evaluated.summary })

  const tick = await ctx.step.do('lever-tick', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const t = unwrap(await runLeverTick(db, tenantId, projectId))
    return { ran: t.ran, archived: t.archived.length, vitals: t.vitals?.verdict ?? null }
  }))
  decisions.push(tick.ran ? `lever tick ran (archived ${tick.archived}${tick.vitals ? `, vitals ${tick.vitals}` : ''})` : 'lever tick already ran today')
  if (tick.vitals === 'futile') decisions.push('FUTILE vitals: recent mature sends draw no replies — check deliverability and targeting')

  const canDiscover = await ctx.step.do('strategies', STEP_RETRY, () =>
    tenantTx(ctx, async (db) => (await getActiveStrategySlugs(db, projectId)).length > 0),
  )
  if (!canDiscover) decisions.push('no active discovery strategies → discovery skipped (set them up from the website URL in the chat)')

  let reachable = await reachableSnapshot(ctx, 'reachable:before')
  let built = false
  if (canDiscover && shouldBuildFirst(reachable, params.outboundCount)) {
    decisions.push(`list low (${reachable.total} reachable, ${reachable.email} by email) → discovery before outbound`)
    const found = await discoverStage(ctx, { kind: 'discover', count: params.outboundCount }, 'discover:first')
    stages.push({ kind: 'discover', summary: found.summary })
    built = true
    reachable = await reachableSnapshot(ctx, 'reachable:after-build')
  }

  let processed = 0
  if (reachable.total > 0) {
    const count = Math.min(params.outboundCount, reachable.total)
    const drafted = await draftStage(ctx, { kind: 'draft', count })
    stages.push({ kind: 'draft', summary: drafted.summary })
    processed = drafted.drafted + drafted.sent + drafted.skipped + drafted.failed
  } else {
    decisions.push(reachable.blocked ? `outbound blocked: ${reachable.blocked}` : 'no reachable prospects → outbound skipped')
  }

  if (canDiscover && !built && !reachable.blocked && reachable.total - processed < 3 * params.outboundCount) {
    decisions.push(`remaining list ${reachable.total - processed} < ${3 * params.outboundCount} → discovery after outbound`)
    const found = await discoverStage(ctx, { kind: 'discover', count: params.outboundCount }, 'discover:after')
    stages.push({ kind: 'discover', summary: found.summary })
  }

  const digest: CycleDigest = { stages, decisions }
  const journal = await journalStage(ctx, digest)
  stages.push({ kind: 'journal', summary: journal.summary })

  const notified = await ctx.step.do('notify', { retries: { limit: 1, delay: '10 seconds' } }, () => tenantTx(ctx, async (db) => {
    const [owner] = await db
      .select({ userId: tenantMembers.userId })
      .from(tenantMembers)
      .where(and(eq(tenantMembers.tenantId, tenantId), eq(tenantMembers.role, 'owner')))
      .limit(1)
    if (!owner) return 'no owner to notify'
    const body = [
      `Daily Cycle Report — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      `Project: ${projectId}`,
      '',
      ...stages.map((s) => `${s.kind}: ${s.summary}`),
      '',
      `Decisions: ${decisions.length > 0 ? decisions.join('; ') : 'none'}`,
    ].join('\n')
    const r = await notifyUser(db, tenantId, owner.userId, googleCtxOf(ctx.env), { subject: `daily-cycle completed: ${projectId}`, body })
    return r.ok ? `notified ${r.value.to}` : `notification failed: ${r.error}`
  }))
  decisions.push(notified)

  return {
    kind: 'daily_cycle',
    summary: stages.map((s) => `${s.kind}: ${s.summary}`).join(' | '),
    stages,
    decisions,
  }
}
