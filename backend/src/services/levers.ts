import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  leverDecisions,
  leverState,
  subjectVariants,
  type LeverDecisionPayload,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import {
  computeVariantWeights,
  type ArchiveDecision,
  type VariantStat,
} from '../domain/subject-bandit'
import {
  aggregateByCoarse,
  computeChannelAffinity,
  type ChannelAffinityMap,
  type ChannelCoarseStat,
} from '../domain/channel-affinity'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'
import { getVariantStats, getChannelStats } from './evaluations'

async function loadActiveVariantIds(db: Db, projectId: ProjectId): Promise<string[]> {
  const rows = await db
    .select({ variantId: subjectVariants.variantId })
    .from(subjectVariants)
    .where(and(eq(subjectVariants.projectId, projectId), isNull(subjectVariants.archivedAt)))
    .orderBy(asc(subjectVariants.variantId))
  return rows.map((r) => r.variantId)
}

export type LeverTickResult = {
  ran: boolean
  cycleDate: string
  minSamplePerArm: number
  weights: Record<string, number>
  archived: ArchiveDecision[]
  samples: VariantStat[]
  channelAffinity: ChannelAffinityMap
  channelSamples: ChannelCoarseStat[]
  needsReplenishment: boolean
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
  const decision = computeVariantWeights(arms, config)
  const channelStats = aggregateByCoarse(await getChannelStats(db, projectId, config))
  const channelAffinity = computeChannelAffinity(channelStats, config)

  const payload: LeverDecisionPayload = {
    subject: { weights: decision.weights, archived: decision.toArchive, samples: arms },
    channel: { affinity: channelAffinity, samples: channelStats },
  }

  // Transaction-stable now() → both uses resolve to the same UTC day (deterministic key).
  const cycleDate = sql`(now() AT TIME ZONE 'UTC')::date`
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
      archived: existing.decision.subject.archived,
      samples: existing.decision.subject.samples,
      channelAffinity: existing.decision.channel?.affinity ?? {},
      channelSamples: existing.decision.channel?.samples ?? [],
      // needsReplenishment is a live current-state signal (never persisted), not part
      // of the applied decision the fields above echo: re-derived under the current
      // config, so a mid-day config change may shift it — intended, not an idempotency
      // break (the applied weights/archived stay fixed; /evaluate reads get_lever_state).
      needsReplenishment: computeVariantWeights(existing.decision.subject.samples, config).needsReplenishment,
    })
  }

  const now = new Date()
  const archiveIds = decision.toArchive.map((a) => a.variantId)
  if (archiveIds.length > 0) {
    await db
      .update(subjectVariants)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(
        eq(subjectVariants.projectId, projectId),
        inArray(subjectVariants.variantId, archiveIds),
        isNull(subjectVariants.archivedAt),
      ))
  }
  await db
    .insert(leverState)
    .values({ projectId, tenantId, variantWeights: decision.weights, channelAffinity, updatedAt: now })
    .onConflictDoUpdate({
      target: leverState.projectId,
      set: { variantWeights: decision.weights, channelAffinity, updatedAt: now },
    })

  return ok({
    ran: true,
    cycleDate: inserted[0]!.cycleDate,
    minSamplePerArm: config.minSamplePerArm,
    weights: decision.weights,
    archived: decision.toArchive,
    samples: arms,
    channelAffinity,
    channelSamples: channelStats,
    needsReplenishment: decision.needsReplenishment,
  })
}

export type LeverStateVariant = {
  variantId: string
  total: number
  responses: number
  mature: boolean
  weight: number | null
}

export type LeverStateView = {
  // null = no tick has run yet → pickSubjectVariant draws uniformly.
  weights: Record<string, number> | null
  channelAffinity: ChannelAffinityMap
  updatedAt: string | null
  minSamplePerArm: number
  variants: LeverStateVariant[]
  todaysDecision: LeverDecisionPayload | null
  // The pool has converged to the floor with a dominated survivor → /evaluate supplies a fresh angle.
  needsReplenishment: boolean
}

export async function getLeverState(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<LeverStateView>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return getLeverStateById(db, tenantId, resolved.value)
}

export async function getLeverStateById(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<LeverStateView>> {
  const config = await loadLeverConfig(db, projectId)
  const activeIds = await loadActiveVariantIds(db, projectId)
  const statsMap = new Map((await getVariantStats(db, projectId, config, true)).map((s) => [s.variantId, s]))
  // Recompute the flag live (same arms the tick uses) so /evaluate, which runs before
  // the tick, reads the current pool state rather than yesterday's decision.
  const arms: VariantStat[] = activeIds.map(
    (id) => statsMap.get(id) ?? { variantId: id, total: 0, responses: 0, rewardSum: 0 },
  )
  const { needsReplenishment } = computeVariantWeights(arms, config)

  const [stateRow] = await db
    .select({
      variantWeights: leverState.variantWeights,
      channelAffinity: leverState.channelAffinity,
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

  return ok({
    weights,
    channelAffinity: stateRow?.channelAffinity ?? {},
    updatedAt: stateRow?.updatedAt ? stateRow.updatedAt.toISOString() : null,
    minSamplePerArm: config.minSamplePerArm,
    variants,
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
}

// Read-only audit trail of the daily tick over the last `days`, newest first. The
// no-control observability surface (P4): narrates how the levers moved, never writes.
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
  }))
  return ok({ decisions })
}
