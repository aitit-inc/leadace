import { z } from 'zod'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { leverState, messageVariants } from '../db/schema'
import type { Db } from '../db/connection'
import { variantIdSchema, type ProjectId, type ProjectRef, type TenantId } from '../domain/ids'
import { weightedDraw } from '../domain/loop/bandit'
import { prepareDrawDistribution } from '../domain/loop/allocation'
import { authorOf, changeReasonSchema } from '../domain/loop/change'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'
import { applyVariantChange, variantCols } from './loop/change'

export const upsertVariantBodySchema = z
  .object({
    variantId: variantIdSchema,
    subjectPattern: z.string().min(1).max(300),
    // Angle brief (2-5 lines) the body is written from; null clears it, leaving
    // the email guidelines alone to shape the body.
    bodyApproach: z.string().min(1).max(2000).nullable().optional(),
    label: z.string().min(1).max(120).nullable().optional(),
    archived: z.boolean().optional(),
    reason: changeReasonSchema.optional(),
  })
  .strict()
export type UpsertVariantBody = z.infer<typeof upsertVariantBodySchema>

export type MessageVariantRow = {
  variantId: string
  subjectPattern: string
  bodyApproach: string | null
  label: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function listMessageVariants(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<{ variants: MessageVariantRow[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return listMessageVariantsById(db, tenantId, resolved.value)
}

export async function listMessageVariantsById(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<{ variants: MessageVariantRow[] }>> {
  const rows = await db
    .select(variantCols)
    .from(messageVariants)
    .where(eq(messageVariants.projectId, projectId))
    .orderBy(asc(messageVariants.createdAt))

  return ok({ variants: rows })
}

export async function upsertMessageVariant(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  projectRef: ProjectRef,
  body: UpsertVariantBody,
): Promise<ServiceResult<MessageVariantRow>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  // Cap check only when this upsert would add an active arm (new active row,
  // or un-archiving); updates to an already-active variant don't change the count.
  if (body.archived !== true) {
    const rows = await db
      .select({ variantId: messageVariants.variantId, archivedAt: messageVariants.archivedAt })
      .from(messageVariants)
      .where(eq(messageVariants.projectId, projectId))
    const existing = rows.find((r) => r.variantId === body.variantId)
    const becomesActive = existing
      ? existing.archivedAt !== null && body.archived === false
      : true
    const otherActive = rows.filter((r) => r.archivedAt === null && r.variantId !== body.variantId).length
    if (becomesActive && otherActive >= (await loadLeverConfig(db, projectId)).maxActiveArms) {
      return err(
        'INVALID_INPUT',
        'Active variant cap reached',
        'The project already has the maximum number of active message variants. Archive one first (the tick may also archive a dominated variant).',
      )
    }
  }

  const { reason, ...write } = body
  const row = await applyVariantChange(db, tenantId, projectId, write, authorOf(caller, reason ?? null))
  if (!row) return err('INTERNAL_ERROR', 'Failed to upsert message variant')
  return ok(row)
}

// Returns null when no variants are active (caller uses a one-off subject).
export type PickedVariant = {
  variantId: string
  subjectPattern: string
  bodyApproach: string | null
  label: string | null
}

export async function pickMessageVariant(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  explicitVariantId?: string,
): Promise<ServiceResult<PickedVariant | null>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const pickCols = {
    variantId: messageVariants.variantId,
    subjectPattern: messageVariants.subjectPattern,
    bodyApproach: messageVariants.bodyApproach,
    label: messageVariants.label,
  }

  if (explicitVariantId) {
    const [row] = await db
      .select(pickCols)
      .from(messageVariants)
      .where(and(
        eq(messageVariants.projectId, projectId),
        eq(messageVariants.variantId, explicitVariantId),
        isNull(messageVariants.archivedAt),
      ))
      .limit(1)
    if (row) return ok(row)
    // Unknown / archived id falls through to the weighted draw.
  }

  const active = await db
    .select(pickCols)
    .from(messageVariants)
    .where(and(
      eq(messageVariants.projectId, projectId),
      isNull(messageVariants.archivedAt),
    ))
    .orderBy(asc(messageVariants.createdAt))

  if (active.length === 0) return ok(null)

  const [stateRow] = await db
    .select({ variantWeights: leverState.variantWeights })
    .from(leverState)
    .where(eq(leverState.projectId, projectId))
    .limit(1)
  const config = await loadLeverConfig(db, projectId)
  const dist = prepareDrawDistribution(
    active.map((v) => v.variantId),
    stateRow?.variantWeights ?? {},
    config,
  )
  const drawnId = weightedDraw(dist, Math.random)
  const picked = active.find((v) => v.variantId === drawnId)
  if (!picked) {
    throw new Error(`Invariant: drawn variant ${drawnId} not in active set for project ${projectId}`)
  }
  return ok(picked)
}
