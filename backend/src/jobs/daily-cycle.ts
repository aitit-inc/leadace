// The daily cycle (daily-cycle/SKILL.md, server-side): evaluate → lever tick →
// outbound → prospect discovery when the list runs low → journal → report.
// Each stage is the same code a standalone job runs; this file only decides
// the order and the counts.
import { NonRetryableError } from 'cloudflare:workflows'
import type { JobKind, JobParamsOf, JobResult } from '../domain/jobs'
import { shouldBuildFirst, type ReachableSnapshot } from '../domain/cycle-plan'
import { runLeverTick } from '../services/levers'
import { getActiveStrategySlugs } from '../services/discovery-strategies'
import { discoveryPausedReason, getRemainingProspectQuota } from '../services/plan-limits'
import { assertTenantComplianceReady, getTenantOwnerUserId } from '../services/tenants'
import { notifyUser } from '../services/notifications'
import { editionOf, googleCtxOf } from '../services/pipeline/context'
import { CYCLE_MIN_CANDIDATES_PER_SEARCH } from '../services/pipeline/discover'
import { listHostedReachable } from '../services/pipeline/draft'
import type { CycleDigest } from '../services/pipeline/journal'
import { discoverStage, draftStage, evaluateStage, journalStage, logStep, STEP_RETRY, tenantTx, unwrap, type StageCtx } from './stages'

// The cycle itself reads nothing of these stages but their summary. Losing one
// costs a day of what it writes, which beats losing the day's sends.
async function advisory(run: () => Promise<{ summary: string }>): Promise<string> {
  try {
    return (await run()).summary
  } catch (e) {
    return `unavailable — ${e instanceof Error ? e.message : String(e)}`
  }
}

async function reachableSnapshot(ctx: StageCtx, name: string): Promise<ReachableSnapshot> {
  return ctx.step.do(name, STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const r = unwrap(await listHostedReachable(db, ctx.job.tenantId, ctx.env, ctx.job.projectId, { limit: 1 }))
    return {
      deliverable: r.withinChannels,
      needsHands: r.total - r.withinChannels,
      blocked: r.outboundBlocked ? r.message ?? 'outbound blocked' : null,
    }
  }))
}

export async function runDailyCycle(ctx: StageCtx, params: JobParamsOf<'daily_cycle'>): Promise<Extract<JobResult, { kind: 'daily_cycle' }>> {
  const { tenantId, projectId } = ctx.job
  const stages: CycleDigest['stages'] = []
  const decisions: string[] = []
  const stage = async (kind: JobKind, summary: string) => {
    const n = stages.push({ kind, summary })
    await logStep(ctx, `stage:${n}`, [{ kind: 'stage', stage: kind, summary }])
  }
  const decide = async (text: string) => {
    const n = decisions.push(text)
    await logStep(ctx, `decision:${n}`, [{ kind: 'decision', text }])
  }

  await ctx.step.do('compliance', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const ready = await assertTenantComplianceReady(db, tenantId)
    if (!ready.ok) throw new NonRetryableError(`${ready.error}${typeof ready.detail === 'string' ? ` — ${ready.detail}` : ''}`)
    return true
  }))

  await stage('evaluate', await advisory(() => evaluateStage(ctx)))

  const tick = await ctx.step.do('lever-tick', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const t = unwrap(await runLeverTick(db, tenantId, projectId))
    return { ran: t.ran, archived: t.archived.length, vitals: t.vitals?.verdict ?? null }
  }))
  await decide(tick.ran ? `lever tick ran (archived ${tick.archived}${tick.vitals ? `, vitals ${tick.vitals}` : ''})` : 'lever tick already ran today')
  if (tick.vitals === 'futile') await decide('FUTILE vitals: recent mature sends draw no interest — check deliverability and targeting')

  const discovery = await ctx.step.do('strategies', STEP_RETRY, () =>
    tenantTx(ctx, async (db) => ({
      hasStrategies: (await getActiveStrategySlugs(db, projectId)).length > 0,
      paused: discoveryPausedReason(await getRemainingProspectQuota(db, tenantId, editionOf(ctx.env))),
    })),
  )
  const canDiscover = discovery.hasStrategies && discovery.paused === null
  if (!discovery.hasStrategies) await decide('no active discovery strategies → discovery skipped (set them up from the website URL in the chat)')
  else if (discovery.paused) await decide(`discovery skipped: ${discovery.paused}`)

  let reachable = await reachableSnapshot(ctx, 'reachable:before')
  let built = false
  if (canDiscover && shouldBuildFirst(reachable, params.outboundCount)) {
    await decide(`list low (${reachable.deliverable} reachable${reachable.needsHands > 0 ? `, ${reachable.needsHands} more need a browser` : ''}) → discovery before outbound`)
    const found = await discoverStage(ctx, { kind: 'discover', count: params.outboundCount, minCandidatesPerSearch: CYCLE_MIN_CANDIDATES_PER_SEARCH }, 'discover:first')
    await stage('discover', found.summary)
    built = true
    reachable = await reachableSnapshot(ctx, 'reachable:after-build')
  }

  let processed = 0
  if (reachable.deliverable > 0) {
    const count = Math.min(params.outboundCount, reachable.deliverable)
    const drafted = await draftStage(ctx, { kind: 'draft', count })
    await stage('draft', drafted.summary)
    processed = drafted.drafted + drafted.sent + drafted.skipped + drafted.failed
  } else {
    await decide(
      reachable.blocked
        ? `outbound blocked: ${reachable.blocked}`
        : `no reachable prospects${reachable.needsHands > 0 ? ` (${reachable.needsHands} need a browser)` : ''} → outbound skipped`,
    )
  }

  if (canDiscover && !built && !reachable.blocked && reachable.deliverable - processed < 3 * params.outboundCount) {
    // Today's sends may have spent the last of the allowance.
    const pausedAfter = await ctx.step.do('strategies:after', STEP_RETRY, () =>
      tenantTx(ctx, async (db) => discoveryPausedReason(await getRemainingProspectQuota(db, tenantId, editionOf(ctx.env)))),
    )
    if (pausedAfter) {
      await decide(`discovery skipped: ${pausedAfter}`)
    } else {
      await decide(`remaining list ${reachable.deliverable - processed} < ${3 * params.outboundCount} → discovery after outbound`)
      const found = await discoverStage(ctx, { kind: 'discover', count: params.outboundCount, minCandidatesPerSearch: CYCLE_MIN_CANDIDATES_PER_SEARCH }, 'discover:after')
      await stage('discover', found.summary)
    }
  }

  const digest: CycleDigest = { stages, decisions }
  await stage('journal', await advisory(() => journalStage(ctx, digest)))

  const notified = await ctx.step.do('notify', { retries: { limit: 1, delay: '10 seconds' } }, () => tenantTx(ctx, async (db) => {
    const owner = await getTenantOwnerUserId(db, tenantId)
    if (!owner) return 'no owner to notify'
    const body = [
      `Daily Cycle Report — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      `Project: ${projectId}`,
      '',
      ...stages.map((s) => `${s.kind}: ${s.summary}`),
      '',
      `Decisions: ${decisions.length > 0 ? decisions.join('; ') : 'none'}`,
    ].join('\n')
    const r = await notifyUser(db, tenantId, owner, googleCtxOf(ctx.env), { subject: `daily-cycle completed: ${projectId}`, body })
    return r.ok ? `notified ${r.value.to}` : `notification failed: ${r.error}`
  }))
  await decide(notified)

  return { kind: 'daily_cycle', summary: stages.map((s) => `${s.kind}: ${s.summary}`).join(' | ') }
}
