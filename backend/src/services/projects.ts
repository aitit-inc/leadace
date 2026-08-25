import { z } from 'zod'
import { eq, and, or, count } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { projects, projectSettings } from '../db/schema'
import { getTenantPlan, getPlanLimits } from './plan-limits'
import { randomFromAlphabet } from '../auth/random-id'
import { ok, err, type ServiceResult } from './result'
import { logFunnel } from './funnel'
import type { Edition } from '../domain/edition'
import { asProjectId, type ProjectId, type ProjectRef, type TenantId } from '../domain/ids'

// Re-export so existing route imports keep working; canonical definition lives in domain.
export { projectRefParamSchema } from '../domain/ids'

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(200),
})
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>

// Id match wins so a project stays addressable by id even when another
// project's name collides with it.
export function pickProjectMatch(
  rows: Array<{ id: string; name: string }>,
  ref: string,
): string | null {
  const byId = rows.find((r) => r.id === ref)
  if (byId) return byId.id
  return rows.find((r) => r.name === ref)?.id ?? null
}

// Doubles as the existence guard. Tenant isolation is enforced by RLS; the
// NOT_FOUND is for response shape, not security.
export async function resolveProject(
  db: Db,
  tenantId: TenantId,
  ref: ProjectRef,
): Promise<ServiceResult<ProjectId>> {
  const rows = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), or(eq(projects.id, ref), eq(projects.name, ref))))
    .limit(2)
  const match = pickProjectMatch(rows, ref)
  if (!match) return err('NOT_FOUND', `Project "${ref}" not found`)
  return ok(asProjectId(match))
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function generateProjectId(length = 21): string {
  return randomFromAlphabet(ID_ALPHABET, length)
}

export type ProjectSummary = {
  id: ProjectId
  name: string
  createdAt: Date
  updatedAt: Date
}

export async function listProjects(
  db: Db,
  tenantId: TenantId,
): Promise<ServiceResult<{ projects: ProjectSummary[] }>> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(eq(projects.tenantId, tenantId))
  return ok({
    projects: rows.map((r) => ({ ...r, id: asProjectId(r.id) })),
  })
}

export type CreateProjectResult = {
  id: ProjectId
  name: string
  tenantId: TenantId
  createdAt: Date
  updatedAt: Date
}

export async function createProject(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  body: CreateProjectBody,
): Promise<ServiceResult<CreateProjectResult>> {
  const { name } = body
  const existing = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.tenantId, tenantId), eq(projects.name, name)))
    .limit(1)

  if (existing.length > 0) {
    return err('CONFLICT', 'Project name already exists')
  }

  const tp = await getTenantPlan(db, tenantId, edition)
  const limits = getPlanLimits(tp.plan)

  if (limits.maxProjects !== null) {
    const [projectCount] = await db
      .select({ count: count() })
      .from(projects)
      .where(eq(projects.tenantId, tenantId))

    if ((projectCount?.count ?? 0) >= limits.maxProjects) {
      return err(
        'FORBIDDEN',
        'Project limit reached',
        `Your ${tp.plan} plan allows ${limits.maxProjects} project(s). Delete an existing project or upgrade your plan.`,
      )
    }
  }

  const id = asProjectId(generateProjectId())
  const now = new Date()
  await db.insert(projects).values({ id, tenantId, name, createdAt: now, updatedAt: now })
  // New projects opt in to follow-up sequencing (opt-out for new data); existing
  // rows store {} and read back disabled.
  await db.insert(projectSettings).values({
    projectId: id,
    tenantId,
    followUpSequence: { enabled: true },
    createdAt: now,
    updatedAt: now,
  })
  logFunnel({ event: 'project_created', tenantId, projectId: id })

  return ok({ id, name, tenantId, createdAt: now, updatedAt: now })
}

export async function deleteProject(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<{ deleted: ProjectId }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  await db.delete(projects).where(eq(projects.id, projectId))
  return ok({ deleted: projectId })
}
