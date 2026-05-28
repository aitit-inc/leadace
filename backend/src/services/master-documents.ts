import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { masterDocuments } from '../db/schema'
import type { Db } from '../db/connection'
import { ok, err, type ServiceResult } from './result'

// master_documents has no RLS (global data) and no tenant scoping. Reads are
// open within the authenticated session — middleware still wraps them in the
// app_rls transaction; a missing policy means SELECT just succeeds.

export const getMasterDocumentParamSchema = z.object({
  slug: z.string().min(1),
})

export type MasterDocumentSummary = {
  slug: string
  version: number
  updatedAt: Date
}

export type MasterDocument = {
  id: number
  slug: string
  content: string
  version: number
  updatedAt: Date
}

export async function listMasterDocuments(
  db: Db,
): Promise<ServiceResult<{ documents: MasterDocumentSummary[] }>> {
  const rows = await db
    .select({
      slug: masterDocuments.slug,
      version: masterDocuments.version,
      updatedAt: masterDocuments.updatedAt,
    })
    .from(masterDocuments)
    .orderBy(masterDocuments.slug)

  return ok({ documents: rows })
}

export async function getMasterDocument(
  db: Db,
  slug: string,
): Promise<ServiceResult<MasterDocument>> {
  const [doc] = await db
    .select({
      id: masterDocuments.id,
      slug: masterDocuments.slug,
      content: masterDocuments.content,
      version: masterDocuments.version,
      updatedAt: masterDocuments.updatedAt,
    })
    .from(masterDocuments)
    .where(eq(masterDocuments.slug, slug))
    .limit(1)

  if (!doc) return err('NOT_FOUND', 'Master document not found')
  return ok(doc)
}
