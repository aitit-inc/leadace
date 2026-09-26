// The daily cycle (daily-cycle/SKILL.md, server-side): evaluate → lever tick →
// follow-ups → new prospects, searching again whenever the list runs out →
// re-approaches → journal → the digest that reports what changed.
// Each stage is the same code a standalone job runs; this file only decides
// the order and the counts.
import { NonRetryableError } from 'cloudflare:workflows'
import type { JobKind, JobParamsOf, JobResult, StrategyPlanCompliance } from '../domain/jobs'
import { nextCycleStep, type CycleStop, type DiscoveryUnavailable, type LastRound, type ReachableSnapshot } from '../domain/cycle-plan'
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
  const planCompliance: StrategyPlanCompliance[] = []
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

  const hasStrategies = await ctx.step.do('strategies', STEP_RETRY, () =>
    tenantTx(ctx, async (db) => (await getActiveStrategySlugs(db, projectId)).length > 0),
  )
  if (!hasStrategies) await decide('no active discovery strategies → discovery skipped (set them up from the website URL in the chat)')

  const daily = await ctx.step.do('daily-target', STEP_RETRY, () => tenantTx(ctx, async (db) => {
    const pace = await loadPlanPace(db, tenantId, editionOf(ctx.env), new Date())
    const target = params.outboundCount !== undefined
      ? { count: params.outboundCount, source: 'this run' }
      : resolveDailyTarget(await loadDailyNewProspects(db, projectId), pace)
    return { target: target.count, source: target.source, pace }
  }))
  await decide(`new prospects today: ${daily.target} (${daily.source})`)

  const before = await reachableSnapshot(ctx, 'reachable:before')

  // The day's count is first touches only. Due follow-ups go first;
  // re-approaches take what the mailboxes have left; the rest wait a day.
  let followUpsOut = 0
  if (before.mailboxRemaining > 0) {
    const followUps = await draftStage(ctx, { kind: 'draft', count: before.mailboxRemaining }, 'draft:followup', 'followup')
    if (tried(followUps) > 0 || followUps.needsHands > 0) await stage('draft', `Follow-ups: ${followUps.summary}`)
    followUpsOut = followUps.drafted + followUps.sent
  }

  let reached = 0
  if (before.blocked) {
    await decide(`outbound blocked: ${before.blocked}`)
  } else {
    const runnable = runnableNewProspects(daily.target, before.sends ? before.mailboxRemaining - followUpsOut : null, daily.pace)
    const drafts: string[] = []
    let last: LastRound = null
    let lastSnap = before
    // A prospect one round tried and failed on must not crowd out what a later pass found.
    const attempted: number[] = []
    let passes = 0
    let stop: CycleStop
    for (let round = 1; ; round++) {
      const snap = round === 1 ? before : await reachableSnapshot(ctx, `reachable:${round}`)
      lastSnap = snap
      // Today's sends may have spent the last of the allowance.
      const discovery = hasStrategies
        ? await ctx.step.do(`discovery:${round}`, STEP_RETRY, () =>
            tenantTx(ctx, async (db): Promise<DiscoveryUnavailable | null> => {
              const paused = discoveryPausedReason(await getRemainingProspectQuota(db, tenantId, editionOf(ctx.env)))
              return paused ? { paused } : null
            }),
          )
        : 'no_strategies'
      const step = nextCycleStep({ want: runnable.count - reached, deliverable: snap.deliverable, last, discovery, passes })
      if (step.kind === 'stop') {
        stop = step.stop
        break
      }
      if (step.kind === 'draft') {
        const drafted = await draftStage(ctx, { kind: 'draft', count: step.count }, `draft:first:${round}`, 'first', attempted)
        drafts.push(drafted.summary)
        const produced = drafted.drafted + drafted.sent
        reached += produced
        last = { kind: 'draft', produced, failed: drafted.failed }
        continue
      }
      passes++
      await decide(`${snap.deliverable} reachable, ${step.count} still wanted${snap.needsHands > 0 ? ` (${snap.needsHands} more need a browser)` : ''} → discovery pass ${passes}`)
      const found = await discoverStage(ctx, { kind: 'discover', count: step.count, minCandidatesPerSearch: CYCLE_MIN_CANDIDATES_PER_SEARCH }, `discover:${passes}`)
      await stage('discover', found.summary)
      planCompliance.push(...found.planCompliance)
      last = { kind: 'discover', deliverableBefore: snap.deliverable }
    }
    const short = shortfallReason({ target: daily.target, runnable, reached, stop })
    const detail = drafts.length > 0 ? drafts.join(' ') : lastSnap.needsHands > 0 ? `${lastSnap.needsHands} need a browser.` : ''
    await stage('draft', `New prospects ${reached} of ${daily.target}${short ? ` (short: ${short})` : ''}. ${detail}`.trim())
  }

  const mailboxLeft = before.mailboxRemaining - followUpsOut - reached
  if (mailboxLeft > 0) {
    const reapproached = await draftStage(ctx, { kind: 'draft', count: mailboxLeft }, 'draft:recycle', 'recycle')
    if (tried(reapproached) > 0 || reapproached.needsHands > 0) await stage('draft', `Re-approaches: ${reapproached.summary}`)
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
