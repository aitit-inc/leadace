import { z } from 'zod'
import { eq, and, count } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { projects, projectProspects } from '../db/schema'
import { getTenantPlan, getPlanLimits } from './plan-limits'
import { randomFromAlphabet } from '../auth/random-id'
import { ok, err, type ServiceResult } from './result'
import type { Edition } from '../domain/edition'
import { asProjectId, type ProjectId, type TenantId } from '../domain/ids'

// Re-export so existing route imports keep working; canonical definition lives in domain.
export { projectIdParamSchema } from '../domain/ids'

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(200),
})
export type CreateProjectBody = z.infer<typeof createProjectBodySchema>

async function verifyProject(db: Db, projectId: ProjectId, tenantId: TenantId) {
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.tenantId, tenantId)))
    .limit(1)
  return project
}

// Translates RLS-hidden / non-existent project into NOT_FOUND. Tenant isolation
// is enforced by RLS; this guard is for response shape, not security.
export async function requireProject(
  db: Db,
  projectId: ProjectId,
  tenantId: TenantId,
): Promise<ServiceResult<undefined>> {
  const found = await verifyProject(db, projectId, tenantId)
  if (!found) return err('NOT_FOUND', 'Project not found')
  return ok(undefined)
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

  return ok({ id, name, tenantId, createdAt: now, updatedAt: now })
}

export async function deleteProject(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<{ deleted: ProjectId }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  await db.delete(projects).where(eq(projects.id, projectId))
  return ok({ deleted: projectId })
}
