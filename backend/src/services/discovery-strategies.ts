import { z } from 'zod'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { discoveryStrategies } from '../db/schema'
import type { Db } from '../db/connection'
import { discoveryStrategySchema, type ProjectId, type ProjectRef, type TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'
import { applyStrategyChange, strategyCols } from './loop/change'
import { authorOf, changeReasonSchema } from '../domain/loop/change'

export const upsertDiscoveryStrategyBodySchema = z
  .object({
    slug: discoveryStrategySchema,
    approach: z.string().min(1).max(2000),
    archived: z.boolean().optional(),
    reason: changeReasonSchema.optional(),
  })
  .strict()
export type UpsertDiscoveryStrategyBody = z.infer<typeof upsertDiscoveryStrategyBodySchema>

export type DiscoveryStrategyRow = {
  slug: string
  approach: string
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export async function listDiscoveryStrategies(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<{ strategies: DiscoveryStrategyRow[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return ok({ strategies: await listDiscoveryStrategiesById(db, resolved.value) })
}

export async function listDiscoveryStrategiesById(
  db: Db,
  projectId: ProjectId,
): Promise<DiscoveryStrategyRow[]> {
  return db
    .select(strategyCols)
    .from(discoveryStrategies)
    .where(eq(discoveryStrategies.projectId, projectId))
    .orderBy(asc(discoveryStrategies.createdAt))
}

export async function getActiveStrategySlugs(db: Db, projectId: ProjectId): Promise<string[]> {
  const rows = await db
    .select({ slug: discoveryStrategies.slug })
    .from(discoveryStrategies)
    .where(and(
      eq(discoveryStrategies.projectId, projectId),
      isNull(discoveryStrategies.archivedAt),
    ))
    .orderBy(asc(discoveryStrategies.slug))
  return rows.map((r) => r.slug)
}

export async function upsertDiscoveryStrategy(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  projectRef: ProjectRef,
  body: UpsertDiscoveryStrategyBody,
): Promise<ServiceResult<DiscoveryStrategyRow>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  // Any upsert without archived: true lands active — registering a slug means
  // wanting it runnable, so re-registering an archived one revives it.
  // Cap check only when this upsert would add an active arm (new active row,
  // or un-archiving); updates to an already-active strategy don't change the count.
  if (body.archived !== true) {
    const rows = await db
      .select({ slug: discoveryStrategies.slug, archivedAt: discoveryStrategies.archivedAt })
      .from(discoveryStrategies)
      .where(eq(discoveryStrategies.projectId, projectId))
    const existing = rows.find((r) => r.slug === body.slug)
    const becomesActive = existing ? existing.archivedAt !== null : true
    const otherActive = rows.filter((r) => r.archivedAt === null && r.slug !== body.slug).length
    if (becomesActive && otherActive >= (await loadLeverConfig(db, projectId)).maxActiveStrategies) {
      return err(
        'INVALID_INPUT',
        'Active discovery-strategy cap reached',
        'The project already has the maximum number of active discovery strategies. Archive one first.',
      )
    }
  }

  const { reason, ...write } = body
  const row = await applyStrategyChange(db, tenantId, projectId, write, authorOf(caller, reason ?? null))
  if (!row) return err('INTERNAL_ERROR', 'Failed to upsert discovery strategy')
  return ok(row)
}
