import { z } from 'zod'
import { eq, and, desc } from 'drizzle-orm'
import { projectDocuments } from '../db/schema'
import type { Db } from '../db/connection'
import {
  projectIdSchema,
  type ProjectId,
  type TenantId,
} from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'

export const documentParamSchema = z.object({
  id: projectIdSchema,
  slug: z.string().min(1),
})
export type DocumentParam = z.infer<typeof documentParamSchema>

export const documentHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
})
export type DocumentHistoryQuery = z.infer<typeof documentHistoryQuerySchema>

export const saveDocumentSchema = z.object({
  content: z.string().min(1),
})
export type SaveDocumentInput = z.infer<typeof saveDocumentSchema>

export async function listDocuments(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<{ documents: Array<{ slug: string; updatedAt: Date }> }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const rows = await db
    .selectDistinctOn([projectDocuments.slug], {
      slug: projectDocuments.slug,
      updatedAt: projectDocuments.createdAt,
    })
    .from(projectDocuments)
    .where(eq(projectDocuments.projectId, projectId))
    .orderBy(projectDocuments.slug, desc(projectDocuments.createdAt))

  return ok({ documents: rows })
}

export type DocumentRow = {
  id: number
  slug: string
  content: string
  createdAt: Date
}

export async function getDocument(
  db: Db,
  tenantId: TenantId,
  param: DocumentParam,
): Promise<ServiceResult<DocumentRow>> {
  const { id: projectId, slug } = param
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const [doc] = await db
    .select({
      id: projectDocuments.id,
      slug: projectDocuments.slug,
      content: projectDocuments.content,
      createdAt: projectDocuments.createdAt,
    })
    .from(projectDocuments)
    .where(and(
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.slug, slug),
    ))
    .orderBy(desc(projectDocuments.createdAt))
    .limit(1)

  if (!doc) return err('NOT_FOUND', 'Document not found')
  return ok(doc)
}

export async function getDocumentHistory(
  db: Db,
  tenantId: TenantId,
  param: DocumentParam,
  query: DocumentHistoryQuery,
): Promise<ServiceResult<{ history: Array<{ id: number; content: string; createdAt: Date }> }>> {
  const { id: projectId, slug } = param
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const rows = await db
    .select({
      id: projectDocuments.id,
      content: projectDocuments.content,
      createdAt: projectDocuments.createdAt,
    })
    .from(projectDocuments)
    .where(and(
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.slug, slug),
    ))
    .orderBy(desc(projectDocuments.createdAt))
    .limit(query.limit)

  return ok({ history: rows })
}

export async function saveDocument(
  db: Db,
  tenantId: TenantId,
  param: DocumentParam,
  input: SaveDocumentInput,
): Promise<ServiceResult<{ id: number; slug: string; createdAt: Date }>> {
  const { id: projectId, slug } = param
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const [doc] = await db
    .insert(projectDocuments)
    .values({ tenantId, projectId, slug, content: input.content })
    .returning({
      id: projectDocuments.id,
      createdAt: projectDocuments.createdAt,
    })

  return ok({ id: doc!.id, slug, createdAt: doc!.createdAt })
}
