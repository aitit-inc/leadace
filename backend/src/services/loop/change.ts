import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { discoveryStrategies, leverState, messageVariants } from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, TenantId } from '../../domain/ids'
import { LIFT_MIN, LIFT_MAX, type TargetingAxisLift } from '../../domain/loop/allocation'
import type { TickDecision } from '../../domain/loop/decide'
import { COARSE_TO_FINES, type CoarseIndustry } from '../../domain/coarse-industry'

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

// Only for a decision whose lever_decisions row this tick claimed.
export async function applyTickDecision(db: Db, tenantId: TenantId, projectId: ProjectId, decision: TickDecision): Promise<void> {
  const { channel: { affinity: channelAffinity }, targeting: { lifts: targetingLifts } } = decision.payload
  const now = new Date()
  const archiveIds = decision.variants.toArchive.map((a) => a.variantId)
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
  const strategyArchiveSlugs = decision.strategies.toArchive.map((a) => a.armId)
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
      variantWeights: decision.variants.weights,
      strategyWeights: decision.strategies.weights,
      channelAffinity,
      targetingLifts,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: leverState.projectId,
      set: {
        variantWeights: decision.variants.weights,
        strategyWeights: decision.strategies.weights,
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
}
