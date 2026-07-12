import { z } from 'zod'
import { and, desc, eq } from 'drizzle-orm'
import { suggestions, SUGGESTION_STATUSES, type SuggestionStatus } from '../db/schema'
import type { Db } from '../db/connection'
import { suggestionKindSchema, type ProjectId, type ProjectRef, type TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'

export const ADD_MEANS_SUGGESTION_KIND = 'add-means'

export const recordSuggestionBodySchema = z.object({
  kind: suggestionKindSchema,
  dedupeKey: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(4000),
  command: z.string().min(1).max(500),
})
export type RecordSuggestionBody = z.infer<typeof recordSuggestionBodySchema>

export const listSuggestionsQuerySchema = z.object({
  status: z.enum(SUGGESTION_STATUSES).optional(),
})
export type ListSuggestionsQuery = z.infer<typeof listSuggestionsQuerySchema>

// The only user-writable transition; 'done' stays server-owned
// (resolveAddMeansSuggestion) and re-opening can be widened later if needed.
export const dismissSuggestionBodySchema = z.object({
  status: z.literal('dismissed'),
})

export type SuggestionRow = {
  id: number
  kind: string
  dedupeKey: string
  title: string
  body: string
  command: string
  status: SuggestionStatus
  createdAt: Date
  updatedAt: Date
}

export type RecordSuggestionResult = {
  id: number
  status: SuggestionStatus
  // false = an existing dismissed/done row was left untouched (user's decision wins).
  written: boolean
}

export async function recordSuggestion(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  body: RecordSuggestionBody,
): Promise<ServiceResult<RecordSuggestionResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [row] = await db
    .insert(suggestions)
    .values({
      tenantId,
      projectId,
      kind: body.kind,
      dedupeKey: body.dedupeKey,
      title: body.title,
      body: body.body,
      command: body.command,
    })
    .onConflictDoUpdate({
      target: [suggestions.projectId, suggestions.kind, suggestions.dedupeKey],
      set: {
        title: body.title,
        body: body.body,
        command: body.command,
        updatedAt: new Date(),
      },
      setWhere: eq(suggestions.status, 'open'),
    })
    .returning({ id: suggestions.id, status: suggestions.status })

  if (row) return ok({ id: row.id, status: row.status, written: true })

  // setWhere skipped the update (row is dismissed/done) — RETURNING was empty.
  const [existing] = await db
    .select({ id: suggestions.id, status: suggestions.status })
    .from(suggestions)
    .where(and(
      eq(suggestions.projectId, projectId),
      eq(suggestions.kind, body.kind),
      eq(suggestions.dedupeKey, body.dedupeKey),
    ))
  if (!existing) return err('CONFLICT', 'Suggestion upsert raced with a concurrent delete')
  return ok({ id: existing.id, status: existing.status, written: false })
}

export async function listSuggestions(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  query: ListSuggestionsQuery,
): Promise<ServiceResult<{ suggestions: SuggestionRow[] }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const rows = await db
    .select({
      id: suggestions.id,
      kind: suggestions.kind,
      dedupeKey: suggestions.dedupeKey,
      title: suggestions.title,
      body: suggestions.body,
      command: suggestions.command,
      status: suggestions.status,
      createdAt: suggestions.createdAt,
      updatedAt: suggestions.updatedAt,
    })
    .from(suggestions)
    .where(and(
      eq(suggestions.projectId, projectId),
      ...(query.status ? [eq(suggestions.status, query.status)] : []),
    ))
    .orderBy(desc(suggestions.updatedAt))

  return ok({ suggestions: rows })
}

export async function dismissSuggestion(
  db: Db,
  tenantId: TenantId,
  suggestionId: number,
): Promise<ServiceResult<{ id: number; status: SuggestionStatus }>> {
  const [row] = await db
    .update(suggestions)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(and(
      eq(suggestions.id, suggestionId),
      eq(suggestions.tenantId, tenantId),
    ))
    .returning({ id: suggestions.id, status: suggestions.status })

  if (!row) return err('NOT_FOUND', 'Suggestion not found')
  return ok(row)
}

export async function resolveAddMeansSuggestion(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  strategySlug: string,
): Promise<void> {
  await db
    .update(suggestions)
    .set({ status: 'done', updatedAt: new Date() })
    .where(and(
      eq(suggestions.tenantId, tenantId),
      eq(suggestions.projectId, projectId),
      eq(suggestions.kind, ADD_MEANS_SUGGESTION_KIND),
      eq(suggestions.dedupeKey, strategySlug),
      eq(suggestions.status, 'open'),
    ))
}
