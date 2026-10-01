import { and, eq } from 'drizzle-orm'
import { leverDecisions, type LeverDecisionPayload } from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectRef, TenantId } from '../../domain/ids'
import type { VitalsAssessment } from '../../domain/loop/frame'
import type { ChannelAffinityMap, ChannelCoarseStat, TargetingLifts } from '../../domain/loop/allocation'
import { decide } from '../../domain/loop/decide'
import { ok, type ServiceResult } from '../result'
import { resolveProject } from '../projects'
import { loadLeverConfig } from '../project-settings'
import { observeTick } from './observe'
import { applyTickDecision, ruleRestoresSince, type RuleRestore } from './change'

export type LeverTickResult = {
  ran: boolean
  cycleDate: string
  minSamplePerArm: number
  weights: Record<string, number>
  // null on ran:false replays of pre-Phase-C decisions.
  pBest: Record<string, number> | null
  archived: LeverDecisionPayload['subject']['archived']
  // What the day's tick brought back, variants and strategies, as logged.
  restored: RuleRestore[]
  samples: LeverDecisionPayload['subject']['samples']
  channelAffinity: ChannelAffinityMap
  channelSamples: ChannelCoarseStat[]
  // null on ran:false replays of pre-Phase-B decisions.
  targetingLifts: TargetingLifts | null
  needsReplenishment: boolean
  // null on ran:false replays of pre-strategy-bandit decisions.
  discovery: NonNullable<LeverDecisionPayload['discovery']> | null
  needsStrategyReplenishment: boolean
  // null on ran:false replays of pre-vitals decisions.
  vitals: VitalsAssessment | null
}

// Idempotent on (project, UTC day): the unique audit insert is the claim, only
// the winner promotes. Runs inside rlsMiddleware's single request transaction,
// so archive + weight upsert + audit commit or roll back together (no db.transaction).
export async function runLeverTick(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<LeverTickResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const config = await loadLeverConfig(db, projectId)
  // One clock source: the same UTC day string seeds the Monte Carlo AND keys
  // the audit row below, so replaying P(best) from (cycle_date, projectId) is
  // exact even for a request that straddles UTC midnight.
  const cycleDate = new Date().toISOString().slice(0, 10)
  const evidence = await observeTick(db, projectId, config)
  const decision = decide(evidence, config, cycleDate, projectId)
  const { payload } = decision

  const inserted = await db
    .insert(leverDecisions)
    .values({ tenantId, projectId, cycleDate, decision: payload })
    .onConflictDoNothing({ target: [leverDecisions.projectId, leverDecisions.cycleDate] })
    .returning({ cycleDate: leverDecisions.cycleDate })

  const dayStart = new Date(`${cycleDate}T00:00:00Z`)
  if (inserted.length === 0) {
    const restored = await ruleRestoresSince(db, projectId, dayStart)
    const [existing] = await db
      .select({ cycleDate: leverDecisions.cycleDate, decision: leverDecisions.decision })
      .from(leverDecisions)
      .where(and(eq(leverDecisions.projectId, projectId), eq(leverDecisions.cycleDate, cycleDate)))
      .limit(1)
    if (!existing) throw new Error(`Invariant: lever_decisions conflict without a row for project ${projectId}`)
    return ok({
      ran: false,
      cycleDate: existing.cycleDate,
      minSamplePerArm: config.minSamplePerArm,
      weights: existing.decision.subject.weights,
      pBest: existing.decision.subject.pBest ?? null,
      archived: existing.decision.subject.archived,
      restored,
      samples: existing.decision.subject.samples,
      channelAffinity: existing.decision.channel?.affinity ?? {},
      channelSamples: existing.decision.channel?.samples ?? [],
      targetingLifts: existing.decision.targeting?.lifts ?? null,
      discovery: existing.decision.discovery ?? null,
      vitals: existing.decision.vitals ?? null,
      // needsReplenishment is a live current-state signal (never persisted), not part
      // of the applied decision the fields above echo — a mid-day archive or config
      // change may shift it while the applied weights stay fixed.
      needsReplenishment: evidence.variants.active.length < config.targetActiveArms,
      needsStrategyReplenishment: evidence.strategies.active.length < config.targetActiveStrategies,
    })
  }

  await applyTickDecision(db, tenantId, projectId, decision)

  return ok({
    ran: true,
    cycleDate: inserted[0]!.cycleDate,
    minSamplePerArm: config.minSamplePerArm,
    weights: decision.variants.weights,
    pBest: decision.variants.pBest,
    archived: payload.subject.archived,
    restored: await ruleRestoresSince(db, projectId, dayStart),
    samples: payload.subject.samples,
    channelAffinity: payload.channel.affinity,
    channelSamples: payload.channel.samples,
    targetingLifts: payload.targeting.lifts,
    discovery: payload.discovery,
    vitals: payload.vitals,
    needsReplenishment: Object.keys(decision.variants.weights).length < config.targetActiveArms,
    needsStrategyReplenishment: Object.keys(decision.strategies.weights).length < config.targetActiveStrategies,
  })
}
