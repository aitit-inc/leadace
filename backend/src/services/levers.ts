import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  discoveryStrategies,
  leverDecisions,
  leverState,
  messageVariants,
  projectProspects,
  prospects,
  type LeverDecisionPayload,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import {
  applyRotation,
  computeVariantWeights,
  isFlatTick,
  isStagnant,
  seededRng,
  type ArchiveDecision,
  type StagnationTick,
  type VariantStat,
} from '../domain/message-bandit'
import { computeArmWeights, floorRescuedWeights, type ArmStat } from '../domain/arm-bandit'
import { assessVitals, type VitalsAssessment } from '../domain/vital-signs'
import { apportionLargestRemainder, type BatchPlanEntry } from '../domain/discovery-allocation'
import type { LeverConfig } from '../domain/lever-config'
import {
  aggregateByCoarse,
  computeChannelAffinity,
  type ChannelAffinityMap,
  type ChannelCoarseStat,
} from '../domain/channel-affinity'
import {
  computeAxisLifts,
  computeFreshSignalLifts,
  overallMeanReward,
  LIFT_MIN,
  LIFT_MAX,
  type TargetingAxisLift,
  type TargetingLifts,
} from '../domain/targeting-score'
import { COARSE_TO_FINES, type CoarseIndustry } from '../domain/coarse-industry'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'
import { getVariantStats, getChannelStats, getTargetingStats, getFutilityStats } from './evaluations'
import { getActiveStrategySlugs, listDiscoveryStrategiesById } from './discovery-strategies'

async function loadActiveVariantIds(db: Db, projectId: ProjectId): Promise<string[]> {
  const rows = await db
    .select({ variantId: messageVariants.variantId })
    .from(messageVariants)
    .where(and(eq(messageVariants.projectId, projectId), isNull(messageVariants.archivedAt)))
    .orderBy(asc(messageVariants.variantId))
  return rows.map((r) => r.variantId)
}

// A stagnation rotation frees a slot for a fresh angle; it stays "unfulfilled"
// until either a new variant row is created after it (evaluate seeds fresh
// slugs, so createdAt marks that) or the active pool grows back past its
// post-rotation size (a user un-archiving an arm refills the slot without a
// new row — the system must not wedge on that override). A later archive can
// flip a count-fulfilled rotation back to unfulfilled; that fails safe by
// re-raising replenishment. While unfulfilled, no further rotation fires and
// needsReplenishment stays raised even at targetActiveArms.
async function hasUnfulfilledRotation(
  db: Db,
  projectId: ProjectId,
  activeCount: number,
): Promise<boolean> {
  const [lastRotation] = await db
    .select({ createdAt: leverDecisions.createdAt, decision: leverDecisions.decision })
    .from(leverDecisions)
    .where(and(
      eq(leverDecisions.projectId, projectId),
      sql`${leverDecisions.decision} @> ${JSON.stringify({ subject: { archived: [{ reason: 'stagnation' }] } })}::jsonb`,
    ))
    .orderBy(desc(leverDecisions.cycleDate))
    .limit(1)
  if (!lastRotation) return false
  const postRotationCount =
    lastRotation.decision.subject.samples.length - lastRotation.decision.subject.archived.length
  if (activeCount > postRotationCount) return false
  const [fresh] = await db
    .select({ id: messageVariants.id })
    .from(messageVariants)
    .where(and(
      eq(messageVariants.projectId, projectId),
      gt(messageVariants.createdAt, lastRotation.createdAt),
    ))
    .limit(1)
  return !fresh
}

// Prior-UTC-day registration counts per strategy — the plan-compliance record
// (§ the tick journals what actually flowed in against yesterday's batchPlan).
// Derived from project_prospects.created_at × prospects.discovery_strategy,
// restricted to this project's registry (archived included — a slug planned
// yesterday may be archived today; a provenance slug carried in by a
// cross-project link is not an arm here and stays out, matching the bandit's
// registry ∩ stats rule). A persistent gap between plan and registrations
// marks a strategy the LLM cannot execute (exhausted or non-existent angle).
async function loadPriorDayRegistrations(
  db: Db,
  projectId: ProjectId,
  cycleDate: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ slug: prospects.discoveryStrategy, count: sql<number>`COUNT(*)::int` })
    .from(projectProspects)
    .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
    .innerJoin(discoveryStrategies, and(
      eq(discoveryStrategies.projectId, projectProspects.projectId),
      eq(discoveryStrategies.slug, prospects.discoveryStrategy),
    ))
    .where(and(
      eq(projectProspects.projectId, projectId),
      isNotNull(prospects.discoveryStrategy),
      sql`${projectProspects.createdAt} >= ((${cycleDate}::date - 1)::timestamp AT TIME ZONE 'UTC')`,
      sql`${projectProspects.createdAt} < ((${cycleDate}::date)::timestamp AT TIME ZONE 'UTC')`,
    ))
    .groupBy(prospects.discoveryStrategy)
  return Object.fromEntries(rows.map((r) => [r.slug!, Number(r.count)]))
}

async function computeNeedsReplenishment(
  db: Db,
  projectId: ProjectId,
  activeCount: number,
  config: { targetActiveArms: number; maxActiveArms: number },
): Promise<boolean> {
  if (activeCount < config.targetActiveArms) return true
  if (activeCount >= config.maxActiveArms) return false
  return hasUnfulfilledRotation(db, projectId, activeCount)
}

export type LeverTickResult = {
  ran: boolean
  cycleDate: string
  minSamplePerArm: number
  weights: Record<string, number>
  // null on ran:false replays of pre-Phase-C decisions.
  pBest: Record<string, number> | null
  archived: ArchiveDecision[]
  samples: VariantStat[]
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

function valueLiftCase(column: ReturnType<typeof sql>, lifts: TargetingAxisLift[]): ReturnType<typeof sql> {
  const nullLift = lifts.find((l) => l.value === null)?.lift ?? 1.0
  const branches = lifts.filter((l): l is { value: string; lift: number } => l.value !== null)
  const whens = branches.map((b) => sql` WHEN ${column} = ${b.value} THEN ${b.lift}::float8`)
  return sql`(CASE WHEN ${column} IS NULL THEN ${nullLift}::float8${sql.join(whens, sql``)} ELSE 1.0 END)`
}

// ELSE carries the 'other' lift (null, 'Other', legacy labels) — must keep
// folding exactly like coarseIndustry().
function industryLiftCase(column: ReturnType<typeof sql>, lifts: TargetingAxisLift[]): ReturnType<typeof sql> {
  const otherLift = lifts.find((l) => l.value === 'other')?.lift ?? 1.0
  const whens = lifts
    .filter((l): l is { value: string; lift: number } => l.value !== null && l.value !== 'other')
    .flatMap((l) => {
      const fines = COARSE_TO_FINES[l.value as CoarseIndustry] ?? []
      if (fines.length === 0) return []
      const list = sql.join(fines.map((f) => sql`${f}`), sql`, `)
      return [sql` WHEN TRIM(COALESCE(${column}, '')) IN (${list}) THEN ${l.lift}::float8`]
    })
  if (whens.length === 0) return sql`${otherLift}::float8`
  return sql`(CASE${sql.join(whens, sql``)} ELSE ${otherLift}::float8 END)`
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
  const activeIds = await loadActiveVariantIds(db, projectId)
  const statsMap = new Map((await getVariantStats(db, projectId, config, true)).map((s) => [s.variantId, s]))
  // Active set only → archived excluded; an active-but-unsent variant is total 0.
  const arms: VariantStat[] = activeIds.map(
    (id) => statsMap.get(id) ?? { variantId: id, total: 0, responses: 0, rewardSum: 0 },
  )
  // One clock source: the same UTC day string seeds the Monte Carlo AND keys
  // the audit row below, so replaying P(best) from (cycle_date, projectId) is
  // exact even for a request that straddles UTC midnight.
  const cycleDate = new Date().toISOString().slice(0, 10)
  const rng = seededRng(`${cycleDate}:${projectId}`)
  let decision = computeVariantWeights(arms, config, rng)

  // Stagnation rotation: only when today has no dominance archive (an archive
  // IS movement) and no earlier rotation is still awaiting its fresh angle.
  if (decision.toArchive.length === 0) {
    const todayTick: StagnationTick = {
      variantIds: arms.map((a) => a.variantId),
      flat: isFlatTick(arms, decision.pBest, config.minSamplePerArm),
    }
    if (todayTick.flat) {
      const history = await db
        .select({ decision: leverDecisions.decision })
        .from(leverDecisions)
        .where(eq(leverDecisions.projectId, projectId))
        .orderBy(desc(leverDecisions.cycleDate))
        .limit(config.stagnationTicks - 1)
      const ticks: StagnationTick[] = [
        todayTick,
        ...history.map((h) => ({
          variantIds: h.decision.subject.samples.map((s) => s.variantId),
          flat:
            h.decision.subject.archived.length === 0 &&
            isFlatTick(h.decision.subject.samples, h.decision.subject.pBest, config.minSamplePerArm),
        })),
      ]
      if (isStagnant(ticks, config.stagnationTicks) && !(await hasUnfulfilledRotation(db, projectId, arms.length))) {
        decision = applyRotation(arms, decision, config)
      }
    }
  }

  const channelStats = aggregateByCoarse(await getChannelStats(db, projectId, config))
  const channelAffinity = computeChannelAffinity(channelStats, config)

  const targetingStats = await getTargetingStats(db, projectId, config, true)
  // industry partitions all mature sends → its sums are the project baseline.
  const r0 = overallMeanReward(targetingStats.industry)
  const targetingLifts: TargetingLifts = {
    industry: computeAxisLifts(targetingStats.industry, r0, config.priorStrength),
    employeeBand: computeAxisLifts(targetingStats.employeeBand, r0, config.priorStrength),
    country: computeAxisLifts(targetingStats.country, r0, config.priorStrength),
    discoveryStrategy: computeAxisLifts(targetingStats.discoveryStrategy, r0, config.priorStrength),
    freshSignal: computeFreshSignalLifts(
      targetingStats.freshSignal.withSignal,
      targetingStats.freshSignal.withoutSignal,
      r0,
      config.priorStrength,
    ),
  }

  // A stats slug outside the active registry stays baseline-only (e.g. carried
  // in by a cross-project link); its own seeded stream so a discovery decision
  // replays without re-running the variant Monte Carlo.
  const activeSlugs = await getActiveStrategySlugs(db, projectId)
  const strategyStats = new Map(
    targetingStats.discoveryStrategy
      .filter((s): s is typeof s & { value: string } => s.value !== null)
      .map((s) => [s.value, s]),
  )
  const strategyArms: ArmStat[] = activeSlugs.map((slug) => ({
    armId: slug,
    total: strategyStats.get(slug)?.total ?? 0,
    rewardSum: strategyStats.get(slug)?.rewardSum ?? 0,
  }))
  const discoveryDecision = computeArmWeights(
    strategyArms,
    {
      minSamplePerArm: config.minSamplePerArm,
      archiveThreshold: config.archiveThreshold,
      weightFloor: config.strategyWeightFloor,
    },
    seededRng(`${cycleDate}:${projectId}:discovery`),
  )
  const discovery: NonNullable<LeverDecisionPayload['discovery']> = {
    weights: discoveryDecision.weights,
    pBest: discoveryDecision.pBest,
    archived: discoveryDecision.toArchive.map(({ armId, pBest, n }) => ({ slug: armId, pBest, n })),
    samples: strategyArms.map(({ armId, total, rewardSum }) => ({ slug: armId, total, rewardSum })),
    registrations: await loadPriorDayRegistrations(db, projectId, cycleDate),
  }

  // Own seeded stream, like discovery: the vitals Monte Carlo must not shift
  // the variant/discovery draws a replay would recompute. Deliberately NOT
  // date-keyed: the verdict thresholds the sampled estimate, so a day-varying
  // seed lets identical data flip futile⇄ok at the confidence boundary
  // (measured: 298 zero-reply sends → pDead 0.9503 one day, 0.9498 the next)
  // and the attention alert would flicker without new evidence.
  const vitals = assessVitals(
    await getFutilityStats(db, projectId, config),
    config,
    seededRng(`vitals:${projectId}`),
  )

  const payload: LeverDecisionPayload = {
    subject: { weights: decision.weights, pBest: decision.pBest, archived: decision.toArchive, samples: arms },
    channel: { affinity: channelAffinity, samples: channelStats },
    targeting: { lifts: targetingLifts, samples: targetingStats },
    discovery,
    vitals,
    configUsed: config,
  }

  const inserted = await db
    .insert(leverDecisions)
    .values({ tenantId, projectId, cycleDate, decision: payload })
    .onConflictDoNothing({ target: [leverDecisions.projectId, leverDecisions.cycleDate] })
    .returning({ cycleDate: leverDecisions.cycleDate })

  if (inserted.length === 0) {
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
      samples: existing.decision.subject.samples,
      channelAffinity: existing.decision.channel?.affinity ?? {},
      channelSamples: existing.decision.channel?.samples ?? [],
      targetingLifts: existing.decision.targeting?.lifts ?? null,
      discovery: existing.decision.discovery ?? null,
      vitals: existing.decision.vitals ?? null,
      // needsReplenishment is a live current-state signal (never persisted), not part
      // of the applied decision the fields above echo — a mid-day archive or config
      // change may shift it while the applied weights stay fixed.
      needsReplenishment: await computeNeedsReplenishment(db, projectId, activeIds.length, config),
      needsStrategyReplenishment: activeSlugs.length < config.targetActiveStrategies,
    })
  }

  const now = new Date()
  const archiveIds = decision.toArchive.map((a) => a.variantId)
  if (archiveIds.length > 0) {
    await db
      .update(messageVariants)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(
        eq(messageVariants.projectId, projectId),
        inArray(messageVariants.variantId, archiveIds),
        isNull(messageVariants.archivedAt),
      ))
  }
  const strategyArchiveSlugs = discoveryDecision.toArchive.map((a) => a.armId)
  if (strategyArchiveSlugs.length > 0) {
    await db
      .update(discoveryStrategies)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(
        eq(discoveryStrategies.projectId, projectId),
        inArray(discoveryStrategies.slug, strategyArchiveSlugs),
        isNull(discoveryStrategies.archivedAt),
      ))
  }
  await db
    .insert(leverState)
    .values({
      projectId,
      tenantId,
      variantWeights: decision.weights,
      strategyWeights: discoveryDecision.weights,
      channelAffinity,
      targetingLifts,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: leverState.projectId,
      set: {
        variantWeights: decision.weights,
        strategyWeights: discoveryDecision.weights,
        channelAffinity,
        targetingLifts,
        updatedAt: now,
      },
    })

  // fresh_signal is deliberately absent — time-varying, applied at read time.
  await db.execute(sql`
    UPDATE project_prospects pp
    SET ordering_score = LEAST(${LIFT_MAX}::float8, GREATEST(${LIFT_MIN}::float8,
        ${industryLiftCase(sql`p.industry`, targetingLifts.industry)}
      * ${valueLiftCase(sql`o.employee_band::text`, targetingLifts.employeeBand)}
      * ${valueLiftCase(sql`UPPER(COALESCE(p.country, o.country))`, targetingLifts.country)}
      * ${valueLiftCase(sql`p.discovery_strategy`, targetingLifts.discoveryStrategy)}
    ))::real
    FROM prospects p
    JOIN organizations o ON o.id = p.organization_id
    WHERE pp.prospect_id = p.id AND pp.project_id = ${projectId}
  `)

  return ok({
    ran: true,
    cycleDate: inserted[0]!.cycleDate,
    minSamplePerArm: config.minSamplePerArm,
    weights: decision.weights,
    pBest: decision.pBest,
    archived: decision.toArchive,
    samples: arms,
    channelAffinity,
    channelSamples: channelStats,
    targetingLifts,
    discovery,
    vitals,
    // Today's decision row is already inserted, so a rotation applied above
    // reads back as an unfulfilled rotation here.
    needsReplenishment: await computeNeedsReplenishment(db, projectId, activeIds.length - archiveIds.length, config),
    needsStrategyReplenishment:
      activeSlugs.length - strategyArchiveSlugs.length < config.targetActiveStrategies,
  })
}

export type LeverStateVariant = {
  variantId: string
  total: number
  responses: number
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
  // Active variants below targetActiveArms, or a stagnation rotation freed a
  // slot that is still unfilled → /evaluate supplies a fresh angle.
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
  // Live flag so /evaluate, which runs before the tick, reads the current pool
  // state rather than yesterday's decision. Includes a rotation-freed slot
  // still awaiting its fresh angle (pool at target but one arm was rotated out).
  const needsReplenishment = await computeNeedsReplenishment(db, projectId, activeIds.length, config)

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
  archived: ArchiveDecision[]
  samples: VariantStat[]
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

  const decisions = rows.map((r) => ({
    cycleDate: r.cycleDate,
    weights: r.decision.subject.weights,
    archived: r.decision.subject.archived,
    samples: r.decision.subject.samples,
    channelAffinity: r.decision.channel?.affinity ?? {},
    targetingLifts: r.decision.targeting?.lifts ?? null,
    discovery: r.decision.discovery ?? null,
    vitals: r.decision.vitals ?? null,
    configUsed: r.decision.configUsed ?? null,
  }))
  return ok({ decisions })
}
