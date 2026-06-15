import { z } from 'zod'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { leverState, subjectVariants } from '../db/schema'
import type { Db } from '../db/connection'
import { variantIdSchema, type ProjectId, type ProjectRef, type TenantId } from '../domain/ids'
import { prepareDrawDistribution, weightedDraw } from '../domain/subject-bandit'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'

export const upsertVariantBodySchema = z
  .object({
    variantId: variantIdSchema,
    subjectPattern: z.string().min(1).max(300),
    label: z.string().min(1).max(120).nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
export type UpsertVariantBody = z.infer<typeof upsertVariantBodySchema>

export type SubjectVariantRow = {
  variantId: string
  subjectPattern: string
  label: string | null
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const variantCols = {
  variantId: subjectVariants.variantId,
  subjectPattern: subjectVariants.subjectPattern,
  label: subjectVariants.label,
  archivedAt: subjectVariants.archivedAt,
  createdAt: subjectVariants.createdAt,
  updatedAt: subjectVariants.updatedAt,
}

export async function listSubjectVariants(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<{ variants: SubjectVariantRow[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return listSubjectVariantsById(db, tenantId, resolved.value)
}

export async function listSubjectVariantsById(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<{ variants: SubjectVariantRow[] }>> {
  const rows = await db
    .select(variantCols)
    .from(subjectVariants)
    .where(eq(subjectVariants.projectId, projectId))
    .orderBy(asc(subjectVariants.createdAt))

  return ok({ variants: rows })
}

// Covers create, edit, archive, and unarchive.
export async function upsertSubjectVariant(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  body: UpsertVariantBody,
): Promise<ServiceResult<SubjectVariantRow>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const now = new Date()
  const archivedAt = body.archived ? now : null

  const [row] = await db
    .insert(subjectVariants)
    .values({
      tenantId,
      projectId,
      variantId: body.variantId,
      subjectPattern: body.subjectPattern,
      label: body.label ?? null,
      archivedAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subjectVariants.projectId, subjectVariants.variantId],
      set: {
        subjectPattern: body.subjectPattern,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.archived !== undefined ? { archivedAt } : {}),
        updatedAt: now,
      },
    })
    .returning(variantCols)

  if (!row) return err('INTERNAL_ERROR', 'Failed to upsert subject variant')
  return ok(row)
}

// Weighted draw over active variants using lever_state weights (uniform when no
// tick has run). Returns null when none are active (caller uses a one-off
// subject). `explicitVariantId` bypasses the draw; unknown / archived fall through.
export type PickedVariant = { variantId: string; subjectPattern: string; label: string | null }

export async function pickSubjectVariant(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  explicitVariantId?: string,
): Promise<ServiceResult<PickedVariant | null>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  if (explicitVariantId) {
    const [row] = await db
      .select({
        variantId: subjectVariants.variantId,
        subjectPattern: subjectVariants.subjectPattern,
        label: subjectVariants.label,
      })
      .from(subjectVariants)
      .where(and(
        eq(subjectVariants.projectId, projectId),
        eq(subjectVariants.variantId, explicitVariantId),
        isNull(subjectVariants.archivedAt),
      ))
      .limit(1)
    if (row) return ok(row)
    // Unknown / archived id falls through to the weighted draw.
  }

  const active = await db
    .select({
      variantId: subjectVariants.variantId,
      subjectPattern: subjectVariants.subjectPattern,
      label: subjectVariants.label,
    })
    .from(subjectVariants)
    .where(and(
      eq(subjectVariants.projectId, projectId),
      isNull(subjectVariants.archivedAt),
    ))
    .orderBy(asc(subjectVariants.createdAt))

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
