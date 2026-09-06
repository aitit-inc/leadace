import { z } from 'zod'
import { eq, and, desc, isNotNull, isNull } from 'drizzle-orm'
import { projectDocuments } from '../db/schema'
import type { Db } from '../db/connection'
import {
  projectRefSchema,
  type ProjectId,
  type ProjectRef,
  type TenantId,
} from '../domain/ids'
import { playbookStrategySlug } from '../domain/discovery-sources'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { resolveAddMeansSuggestion } from './suggestions'
import { PUBLIC_JOURNAL_SLUG } from './public-scoreboard'
import { redactPublicJournal } from './public-journal'
import type { OpenAIEnv } from './openai'

// public_journal: one version per daily cycle, served on /live while the
// project's publicScoreboardEnabled setting is on.
const DOCUMENT_SLUGS = ['business', 'sales_strategy', 'search_notes', 'learnings', PUBLIC_JOURNAL_SLUG] as const

function isWritableSlug(slug: string): boolean {
  return (DOCUMENT_SLUGS as readonly string[]).includes(slug) || playbookStrategySlug(slug) !== null
}

export const documentParamSchema = z.object({
  id: projectRefSchema,
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

export const approveDocumentSchema = z.object({
  id: z.number().int().positive(),
})
export type ApproveDocumentInput = z.infer<typeof approveDocumentSchema>

export async function listDocuments(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<{ documents: Array<{ slug: string; updatedAt: Date }> }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

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
  approvedAt: Date | null
}

const documentCols = {
  id: projectDocuments.id,
  slug: projectDocuments.slug,
  content: projectDocuments.content,
  createdAt: projectDocuments.createdAt,
  approvedAt: projectDocuments.approvedAt,
}

// A playbook is followed as procedure (it may carry scripts), so the agent
// reads only versions a human approved in the Web UI. Every other slug, and
// the Web UI itself, reads the newest version.
function agentReadsApprovedOnly(caller: 'browser' | 'agent', slug: string): boolean {
  return caller === 'agent' && playbookStrategySlug(slug) !== null
}

export async function getDocument(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  param: DocumentParam,
): Promise<ServiceResult<DocumentRow>> {
  const { id: projectRef, slug } = param
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const approvedOnly = agentReadsApprovedOnly(caller, slug)
  const [doc] = await db
    .select(documentCols)
    .from(projectDocuments)
    .where(and(
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.slug, slug),
      ...(approvedOnly ? [isNotNull(projectDocuments.approvedAt)] : []),
    ))
    .orderBy(desc(projectDocuments.createdAt))
    .limit(1)

  if (doc) return ok(doc)
  if (approvedOnly) {
    const [pending] = await db
      .select({ id: projectDocuments.id })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.slug, slug)))
      .limit(1)
    if (pending) {
      return err(
        'PRECONDITION_FAILED',
        'Playbook awaiting approval',
        'Approve the pending version in the Web UI → Documents before skills can follow it.',
      )
    }
  }
  return err('NOT_FOUND', 'Document not found')
}

export async function getDocumentHistory(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  param: DocumentParam,
  query: DocumentHistoryQuery,
): Promise<ServiceResult<{ history: Array<{ id: number; content: string; createdAt: Date; approvedAt: Date | null }> }>> {
  const { id: projectRef, slug } = param
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const rows = await db
    .select({
      id: projectDocuments.id,
      content: projectDocuments.content,
      createdAt: projectDocuments.createdAt,
      approvedAt: projectDocuments.approvedAt,
    })
    .from(projectDocuments)
    .where(and(
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.slug, slug),
      ...(agentReadsApprovedOnly(caller, slug) ? [isNotNull(projectDocuments.approvedAt)] : []),
    ))
    .orderBy(desc(projectDocuments.createdAt))
    .limit(query.limit)

  return ok({ history: rows })
}

export type SaveDocumentResult = {
  id: number
  slug: string
  createdAt: Date
  approvedAt: Date | null
}

export async function saveDocument(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  env: OpenAIEnv,
  param: DocumentParam,
  input: SaveDocumentInput,
): Promise<ServiceResult<SaveDocumentResult>> {
  const { id: projectRef, slug } = param
  if (!isWritableSlug(slug)) {
    return err(
      'INVALID_INPUT',
      'Unknown document slug',
      `Expected one of ${DOCUMENT_SLUGS.join(', ')} or playbook_<strategy-slug>.`,
    )
  }
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const content =
    slug === PUBLIC_JOURNAL_SLUG ? await redactPublicJournal(env, input.content) : ok(input.content)
  if (!content.ok) return content

  const approvedAt = caller === 'browser' ? new Date() : null
  const [doc] = await db
    .insert(projectDocuments)
    .values({ tenantId, projectId, slug, content: content.value, approvedAt })
    .returning({
      id: projectDocuments.id,
      createdAt: projectDocuments.createdAt,
      approvedAt: projectDocuments.approvedAt,
    })

  if (approvedAt) await closeAddMeansSuggestion(db, tenantId, projectId, slug)

  return ok({
    id: doc!.id,
    slug,
    createdAt: doc!.createdAt,
    approvedAt: doc!.approvedAt,
  })
}

export async function approveDocumentVersion(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'agent',
  param: DocumentParam,
  input: ApproveDocumentInput,
): Promise<ServiceResult<SaveDocumentResult>> {
  const { id: projectRef, slug } = param
  if (caller !== 'browser') return err('FORBIDDEN', 'Playbook approval is a Web UI action')
  if (playbookStrategySlug(slug) === null) {
    return err('INVALID_INPUT', 'Only playbook_<strategy-slug> documents take approval')
  }
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  // The NULL predicate makes the stamp atomic: a concurrent second approval
  // updates zero rows and reads back as already approved.
  const [updated] = await db
    .update(projectDocuments)
    .set({ approvedAt: new Date() })
    .where(and(
      eq(projectDocuments.id, input.id),
      eq(projectDocuments.projectId, projectId),
      eq(projectDocuments.slug, slug),
      isNull(projectDocuments.approvedAt),
    ))
    .returning({
      id: projectDocuments.id,
      createdAt: projectDocuments.createdAt,
      approvedAt: projectDocuments.approvedAt,
    })

  if (!updated) {
    const [row] = await db
      .select({ id: projectDocuments.id })
      .from(projectDocuments)
      .where(and(
        eq(projectDocuments.id, input.id),
        eq(projectDocuments.projectId, projectId),
        eq(projectDocuments.slug, slug),
      ))
      .limit(1)
    return row
      ? err('CONFLICT', 'Version already approved')
      : err('NOT_FOUND', 'Document version not found')
  }

  await closeAddMeansSuggestion(db, tenantId, projectId, slug)

  return ok({
    id: updated.id,
    slug,
    createdAt: updated.createdAt,
    approvedAt: updated.approvedAt,
  })
}

// An approved playbook completes its add-means suggestion — closed here so
// the plugin needs no wiring.
async function closeAddMeansSuggestion(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  slug: string,
): Promise<void> {
  const strategySlug = playbookStrategySlug(slug)
  if (strategySlug) await resolveAddMeansSuggestion(db, tenantId, projectId, strategySlug)
}
