import { z } from 'zod'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { projectSettings, subjectVariants } from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'

// Stable slug for URLs / analytics joins.
const VARIANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,32}$/

export const upsertVariantBodySchema = z
  .object({
    variantId: z.string().regex(VARIANT_ID_REGEX),
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
  projectId: ProjectId,
): Promise<ServiceResult<{ variants: SubjectVariantRow[] }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

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
  projectId: ProjectId,
  body: UpsertVariantBody,
): Promise<ServiceResult<SubjectVariantRow>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

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

// Round-robin selection from active variants. The cursor advance is
// best-effort fairness: concurrent /outbound runs may both read the same
// value before the update lands, but the result is still rotation rather
// than always picking variant 0. Returns null when no active variants exist
// (caller falls back to an LLM-generated one-off subject).
// `explicitVariantId` bypasses rotation; unknown / archived slugs fall through.
export type PickedVariant = { variantId: string; subjectPattern: string; label: string | null }

export async function pickSubjectVariant(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  explicitVariantId?: string,
): Promise<ServiceResult<PickedVariant | null>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

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
    // Unknown / archived id falls through to round-robin.
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

  const now = new Date()
  const [advancedRow] = await db
    .update(projectSettings)
    .set({
      subjectVariantCursor: sql`((${projectSettings.subjectVariantCursor} + 1) % ${active.length})`,
      updatedAt: now,
    })
    .where(eq(projectSettings.projectId, projectId))
    .returning({ cursor: projectSettings.subjectVariantCursor })

  if (!advancedRow) {
    throw new Error(`Invariant: project_settings row missing for project ${projectId}`)
  }
  // We wrote the *next* cursor; the current pick is one step behind.
  const idx = ((advancedRow.cursor - 1) % active.length + active.length) % active.length
  return ok(active[idx]!)
}
