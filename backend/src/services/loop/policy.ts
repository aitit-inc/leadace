import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { leverDecisions, leverState, type LeverDecisionPayload } from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../../domain/ids'
import type { VitalsAssessment } from '../../domain/loop/frame'
import {
  apportionLargestRemainder,
  floorRescuedWeights,
  type BatchPlanEntry,
  type ChannelAffinityMap,
  type TargetingLifts,
} from '../../domain/loop/allocation'
import type { LeverConfig } from '../../domain/loop/config'
import { ok, type ServiceResult } from '../result'
import { resolveProject } from '../projects'
import { loadLeverConfig } from '../project-settings'
import { listDiscoveryStrategiesById } from '../discovery-strategies'
import { getVariantStats, loadActiveVariantIds } from './observe'
import { ruleRestoresSince, type RuleRestore } from './change'

export type LeverStateVariant = {
  variantId: string
  total: number
  responses: number
  positive: number
  interested: number
  mature: boolean
  weight: number | null
}

const DEFAULT_BATCH_PLAN_SIZE = 30

export const leverStateQuerySchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(200).default(DEFAULT_BATCH_PLAN_SIZE),
})
export type LeverStateQuery = z.infer<typeof leverStateQuerySchema>

export type LeverStateView = {
  // null = no tick has run yet → pickMessageVariant draws uniformly.
  weights: Record<string, number> | null
  channelAffinity: ChannelAffinityMap
  // null = no tick has computed targeting lifts yet → neutral ordering.
  targetingLifts: TargetingLifts | null
  updatedAt: string | null
  minSamplePerArm: number
  variants: LeverStateVariant[]
  discovery: {
    strategies: Array<{ slug: string; approach: string; archivedAt: string | null }>
    // null = no lever_state row yet; {} = no tick has weighed strategies yet.
    weights: Record<string, number> | null
    // Server-side apportionment of the registration batch across active
    // strategies (largest remainder over the tick's weights; uniform until a
    // tick has weighed the active set). /build-list constructs its batch to
    // this plan; a 0 count is an explicit skip.
    batchPlan: BatchPlanEntry[]
    // Active strategies below targetActiveStrategies → /evaluate registers fresh ones.
    needsReplenishment: boolean
  }
  todaysDecision: LeverDecisionPayload | null
  // Active variants below targetActiveArms → /evaluate supplies a fresh angle.
  needsReplenishment: boolean
}

export async function getLeverState(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  query: LeverStateQuery,
): Promise<ServiceResult<LeverStateView>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return getLeverStateById(db, tenantId, resolved.value, query.batchSize)
}

export async function getLeverStateById(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  batchSize: number = DEFAULT_BATCH_PLAN_SIZE,
): Promise<ServiceResult<LeverStateView>> {
  const config = await loadLeverConfig(db, projectId)
  const activeIds = await loadActiveVariantIds(db, projectId)
  const statsMap = new Map((await getVariantStats(db, projectId, config, true)).map((s) => [s.variantId, s]))
  // Live flag so /evaluate reads the current pool state whether or not today's
  // tick has run (the plugin's cycle still evaluates first).
  const needsReplenishment = activeIds.length < config.targetActiveArms

  const [stateRow] = await db
    .select({
      variantWeights: leverState.variantWeights,
      strategyWeights: leverState.strategyWeights,
      channelAffinity: leverState.channelAffinity,
      targetingLifts: leverState.targetingLifts,
      updatedAt: leverState.updatedAt,
    })
    .from(leverState)
    .where(eq(leverState.projectId, projectId))
    .limit(1)
  const weights = stateRow?.variantWeights ?? null

  const [today] = await db
    .select({ decision: leverDecisions.decision })
    .from(leverDecisions)
    .where(and(
      eq(leverDecisions.projectId, projectId),
      eq(leverDecisions.cycleDate, sql`(now() AT TIME ZONE 'UTC')::date`),
    ))
    .limit(1)

  const variants: LeverStateVariant[] = activeIds.map((id) => {
    const s = statsMap.get(id)
    const total = s?.total ?? 0
    return {
      variantId: id,
      total,
      responses: s?.responses ?? 0,
      positive: s?.positive ?? 0,
      interested: s?.interested ?? 0,
      mature: total >= config.minSamplePerArm,
      weight: weights ? weights[id] ?? null : null,
    }
  })

  const strategies = (await listDiscoveryStrategiesById(db, projectId)).map((s) => ({
    slug: s.slug,
    approach: s.approach,
    archivedAt: s.archivedAt ? s.archivedAt.toISOString() : null,
  }))
  const activeSlugs = strategies.filter((s) => s.archivedAt === null).map((s) => s.slug)

  // Apportion over the tick's weights restricted to the currently active set.
  // An active slug the tick hasn't weighed yet (registered since) enters at
  // the floor — the same rescue the next tick would grant it; when nothing
  // carries weight (no tick yet, or a zero floor) the plan degrades to a
  // uniform spread — the pre-bandit behavior.
  const storedWeights = stateRow?.strategyWeights ?? {}
  const planWeights = floorRescuedWeights(activeSlugs, storedWeights, config.strategyWeightFloor)
  const batchPlan = apportionLargestRemainder(
    Object.values(planWeights).reduce((acc, w) => acc + w, 0) > 0
      ? planWeights
      : Object.fromEntries(activeSlugs.map((slug) => [slug, 1])),
    batchSize,
  )

  return ok({
    weights,
    channelAffinity: stateRow?.channelAffinity ?? {},
    targetingLifts: stateRow?.targetingLifts ?? null,
    updatedAt: stateRow?.updatedAt ? stateRow.updatedAt.toISOString() : null,
    minSamplePerArm: config.minSamplePerArm,
    variants,
    discovery: {
      strategies,
      weights: stateRow?.strategyWeights ?? null,
      batchPlan,
      needsReplenishment: activeSlugs.length < config.targetActiveStrategies,
    },
    todaysDecision: today?.decision ?? null,
    needsReplenishment,
  })
}

export const leverDecisionsHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
})
export type LeverDecisionsHistoryQuery = z.infer<typeof leverDecisionsHistoryQuerySchema>

export type LeverDecisionHistoryEntry = {
  cycleDate: string
  weights: Record<string, number>
  archived: LeverDecisionPayload['subject']['archived']
  // What that day's tick brought back, variants and strategies, as logged.
  restored: RuleRestore[]
  samples: LeverDecisionPayload['subject']['samples']
  channelAffinity: ChannelAffinityMap
  // null on pre-Phase-B decisions.
  targetingLifts: TargetingLifts | null
  // Both null on pre-strategy-bandit decisions.
  discovery: NonNullable<LeverDecisionPayload['discovery']> | null
  // null on pre-vitals decisions.
  vitals: VitalsAssessment | null
  configUsed: LeverConfig | null
}

export async function getLeverDecisionsHistory(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  days: number,
): Promise<ServiceResult<{ decisions: LeverDecisionHistoryEntry[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const rows = await db
    .select({ cycleDate: leverDecisions.cycleDate, decision: leverDecisions.decision })
    .from(leverDecisions)
    .where(and(
      eq(leverDecisions.projectId, projectId),
      sql`${leverDecisions.cycleDate} >= (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${days})`,
    ))
    .orderBy(desc(leverDecisions.cycleDate))
  const oldest = rows.at(-1)
  const restores = oldest ? await ruleRestoresSince(db, projectId, new Date(`${oldest.cycleDate}T00:00:00Z`)) : []

  const decisions = rows.map((r) => ({
    cycleDate: r.cycleDate,
    weights: r.decision.subject.weights,
    archived: r.decision.subject.archived,
    restored: restores.filter((x) => x.day === r.cycleDate),
    samples: r.decision.subject.samples,
    channelAffinity: r.decision.channel?.affinity ?? {},
    targetingLifts: r.decision.targeting?.lifts ?? null,
    discovery: r.decision.discovery ?? null,
    vitals: r.decision.vitals ?? null,
    configUsed: r.decision.configUsed ?? null,
  }))
  return ok({ decisions })
}
