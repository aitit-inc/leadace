// The daily cycle (daily-cycle/SKILL.md, server-side): evaluate → lever tick →
// outbound → prospect discovery when the list runs low → journal → the digest
// that reports what changed.
// Each stage is the same code a standalone job runs; this file only decides
// the order and the counts.
import { NonRetryableError } from 'cloudflare:workflows'
import type { JobKind, JobParamsOf, JobResult, StrategyPlanCompliance } from '../domain/jobs'
import { shouldBuildFirst, type ReachableSnapshot } from '../domain/cycle-plan'
import { resolveDailyTarget, runnableNewProspects, shortfallReason } from '../domain/daily-target'
import { loadDailyNewProspects, loadPlanPace } from '../services/daily-target'
import { sendCycleDigest } from '../services/digest'
import { runLeverTick } from '../services/levers'
import { notifyCtxOf } from '../services/notifications'
import { getActiveStrategySlugs } from '../services/discovery-strategies'
import { discoveryPausedReason, getRemainingProspectQuota } from '../services/plan-limits'
import { assertTenantComplianceReady } from '../services/tenants'
import { editionOf } from '../services/pipeline/context'
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

function tried(r: Extract<JobResult, { kind: 'draft' }>): number {
  return r.drafted + r.sent + r.skipped + r.failed
}

async function reachableSnapshot(ctx: StageCtx, name: string): Promise<ReachableSnapshot> {
  return ctx.step.do(name, STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const r = unwrap(await listHostedReachable(db, ctx.job.tenantId, ctx.env, ctx.job.projectId, { limit: 1, arm: 'first' }))
    return {
      deliverable: r.withinChannels,
      needsHands: r.total - r.withinChannels,
      mailboxRemaining: r.mailboxQuota.kind === 'no_mailbox' ? 0 : r.mailboxQuota.remaining,
      sends: r.outboundMode === 'send',
      blocked: r.outboundBlocked ? r.message ?? 'outbound blocked' : null,
    }
  }))
}

export async function runDailyCycle(ctx: StageCtx, params: JobParamsOf<'daily_cycle'>): Promise<Extract<JobResult, { kind: 'daily_cycle' }>> {
  const { tenantId, projectId } = ctx.job
  const stages: CycleDigest['stages'] = []
  const decisions: string[] = []
  // The two discovery branches below exclude each other, so this is one pass.
  let planCompliance: StrategyPlanCompliance[] = []
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

  const daily = await ctx.step.do('daily-target', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const pace = await loadPlanPace(db, tenantId, editionOf(ctx.env), new Date())
    const target = params.outboundCount !== undefined
      ? { count: params.outboundCount, source: 'this run' }
      : resolveDailyTarget(await loadDailyNewProspects(db, projectId), pace)
    return { target: target.count, source: target.source, pace }
  }))
  await decide(`new prospects today: ${daily.target} (${daily.source})`)

  let reachable = await reachableSnapshot(ctx, 'reachable:before')
  // Sized before the day's follow-ups take their share of the mailboxes.
  const wanted = runnableNewProspects(daily.target, reachable.sends ? reachable.mailboxRemaining : null, daily.pace).count
  let built = false
  if (canDiscover && wanted > 0 && shouldBuildFirst(reachable, wanted)) {
    await decide(`list low (${reachable.deliverable} reachable${reachable.needsHands > 0 ? `, ${reachable.needsHands} more need a browser` : ''}) → discovery before outbound`)
    const found = await discoverStage(ctx, { kind: 'discover', count: wanted, minCandidatesPerSearch: CYCLE_MIN_CANDIDATES_PER_SEARCH }, 'discover:first')
    await stage('discover', found.summary)
    planCompliance = found.planCompliance
    built = true
    reachable = await reachableSnapshot(ctx, 'reachable:after-build')
  }

  // The day's count is first touches only. Due follow-ups go first;
  // re-approaches take what the mailboxes have left; the rest wait a day.
  let produced = 0
  if (reachable.mailboxRemaining > 0) {
    const followUps = await draftStage(ctx, { kind: 'draft', count: reachable.mailboxRemaining }, 'draft:followup', 'followup')
    if (tried(followUps) > 0 || followUps.needsHands > 0) await stage('draft', `Follow-ups: ${followUps.summary}`)
    produced += followUps.drafted + followUps.sent
  }

  const runnable = runnableNewProspects(daily.target, reachable.sends ? reachable.mailboxRemaining - produced : null, daily.pace)
  let processed = 0
  if (!reachable.blocked) {
    const count = Math.min(runnable.count, reachable.deliverable)
    const drafted = count > 0 ? await draftStage(ctx, { kind: 'draft', count }, 'draft', 'first') : null
    const reached = drafted ? drafted.drafted + drafted.sent : 0
    const short = shortfallReason({ target: daily.target, runnable, deliverable: reachable.deliverable, produced: reached, failed: drafted?.failed ?? 0 })
    const detail = drafted ? drafted.summary : reachable.needsHands > 0 ? `${reachable.needsHands} need a browser.` : ''
    await stage('draft', `New prospects ${reached} of ${daily.target}${short ? ` (short: ${short})` : ''}. ${detail}`.trim())
    processed = drafted ? tried(drafted) : 0
    produced += reached
  } else {
    await decide(`outbound blocked: ${reachable.blocked}`)
  }

  const mailboxLeft = reachable.mailboxRemaining - produced
  if (mailboxLeft > 0) {
    const reapproached = await draftStage(ctx, { kind: 'draft', count: mailboxLeft }, 'draft:recycle', 'recycle')
    if (tried(reapproached) > 0 || reapproached.needsHands > 0) await stage('draft', `Re-approaches: ${reapproached.summary}`)
  }

  if (canDiscover && !built && !reachable.blocked && wanted > 0 && reachable.deliverable - processed < 3 * wanted) {
    // Today's sends may have spent the last of the allowance.
    const pausedAfter = await ctx.step.do('strategies:after', STEP_RETRY, () =>
      tenantTx(ctx, async (db) => discoveryPausedReason(await getRemainingProspectQuota(db, tenantId, editionOf(ctx.env)))),
    )
    if (pausedAfter) {
      await decide(`discovery skipped: ${pausedAfter}`)
    } else {
      await decide(`remaining list ${reachable.deliverable - processed} < ${3 * wanted} → discovery after outbound`)
      const found = await discoverStage(ctx, { kind: 'discover', count: wanted, minCandidatesPerSearch: CYCLE_MIN_CANDIDATES_PER_SEARCH }, 'discover:after')
      await stage('discover', found.summary)
      planCompliance = found.planCompliance
    }
  }

  const digest: CycleDigest = { stages, decisions }
  await stage('journal', await advisory(() => journalStage(ctx, digest)))

  // Advisory like the journal: a report that could not go out must not fail the
  // day it reports on.
  await ctx.step.do('digest', async () => {
    const failure = await sendCycleDigest(
      (fn) => tenantTx(ctx, fn),
      tenantId,
      { ...notifyCtxOf(ctx.env), edition: editionOf(ctx.env) },
      projectId,
    ).then(
      (r) => (r.ok ? null : r.error),
      (e) => (e instanceof Error ? e.message : String(e)),
    )
    if (failure) console.warn(`[cycle] digest failed project=${projectId}: ${failure}`)
    return true
  })

  return { kind: 'daily_cycle', summary: stages.map((s) => `${s.kind}: ${s.summary}`).join(' | '), planCompliance }
}
