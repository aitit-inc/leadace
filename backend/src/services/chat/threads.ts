// Chat threads and messages: the hosted agent's conversation store. The agent
// loop (services/chat/agent.ts) reads and appends here; jobs append their
// completion notices here; the Web UI lists and reads here.
import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection'
import { chatMessages, chatThreads } from '../../db/schema'
import type { ChatContent, ChatRole, PendingCall } from '../../domain/chat'
import { asProjectId, projectRefSchema, type ProjectId, type TenantId } from '../../domain/ids'
import { randomFromAlphabet } from '../../auth/random-id'
import { ok, err, type ServiceResult } from '../result'
import { resolveProject } from '../projects'

export const createThreadBodySchema = z
  .object({
    projectId: projectRefSchema.optional(),
    title: z.string().min(1).max(120).optional(),
  })
  .strict()
export type CreateThreadBody = z.infer<typeof createThreadBodySchema>

export const listThreadsQuerySchema = z.object({
  projectId: projectRefSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
})
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>

export const messageBodySchema = z.object({ text: z.string().min(1).max(8000) }).strict()
export const confirmBodySchema = z.object({ callId: z.string().min(1), approve: z.boolean() }).strict()
export const threadIdParamSchema = z.object({ id: z.string().min(1).max(64) })

export type ThreadView = {
  id: string
  projectId: ProjectId | null
  title: string
  pendingCall: PendingCall | null
  createdAt: Date
  updatedAt: Date
}

export type MessageView = {
  id: number
  role: ChatRole
  content: ChatContent
  createdAt: Date
}

const threadCols = {
  id: chatThreads.id,
  projectId: chatThreads.projectId,
  title: chatThreads.title,
  pendingCall: chatThreads.pendingCall,
  createdAt: chatThreads.createdAt,
  updatedAt: chatThreads.updatedAt,
}

const messageCols = {
  id: chatMessages.id,
  role: chatMessages.role,
  content: chatMessages.content,
  createdAt: chatMessages.createdAt,
}

function toThreadView(row: typeof chatThreads.$inferSelect extends infer R ? Omit<R, 'tenantId'> : never): ThreadView {
  return { ...row, projectId: row.projectId === null ? null : asProjectId(row.projectId) }
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export async function createThread(
  db: Db,
  tenantId: TenantId,
  body: CreateThreadBody,
): Promise<ServiceResult<ThreadView>> {
  let projectId: ProjectId | null = null
  if (body.projectId) {
    const resolved = await resolveProject(db, tenantId, body.projectId)
    if (!resolved.ok) return resolved
    projectId = resolved.value
  }
  const now = new Date()
  const [row] = await db
    .insert(chatThreads)
    .values({ id: randomFromAlphabet(ID_ALPHABET, 21), tenantId, projectId, title: body.title ?? 'New chat', createdAt: now, updatedAt: now })
    .returning(threadCols)
  if (!row) throw new Error('Invariant: thread insert returned no row')
  return ok(toThreadView(row))
}

export async function listThreads(
  db: Db,
  tenantId: TenantId,
  query: ListThreadsQuery,
): Promise<ServiceResult<{ threads: ThreadView[] }>> {
  const conditions = [eq(chatThreads.tenantId, tenantId)]
  if (query.projectId) {
    const resolved = await resolveProject(db, tenantId, query.projectId)
    if (!resolved.ok) return resolved
    conditions.push(eq(chatThreads.projectId, resolved.value))
  }
  const rows = await db
    .select(threadCols)
    .from(chatThreads)
    .where(and(...conditions))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(query.limit)
  return ok({ threads: rows.map(toThreadView) })
}

export async function getThread(db: Db, tenantId: TenantId, id: string): Promise<ServiceResult<ThreadView>> {
  const [row] = await db
    .select(threadCols)
    .from(chatThreads)
    .where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, id)))
    .limit(1)
  if (!row) return err('NOT_FOUND', 'Thread not found')
  return ok(toThreadView(row))
}

export async function deleteThread(db: Db, tenantId: TenantId, id: string): Promise<ServiceResult<{ id: string }>> {
  const [row] = await db
    .delete(chatThreads)
    .where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, id)))
    .returning({ id: chatThreads.id })
  if (!row) return err('NOT_FOUND', 'Thread not found')
  return ok(row)
}

export const MESSAGE_HISTORY_LIMIT = 200

export async function listMessages(
  db: Db,
  tenantId: TenantId,
  threadId: string,
): Promise<ServiceResult<{ messages: MessageView[] }>> {
  const thread = await getThread(db, tenantId, threadId)
  if (!thread.ok) return thread
  // Newest first at the limit, then chronological: the model and the UI must
  // always see the latest exchange, never a stale head of a long thread.
  const rows = await db
    .select(messageCols)
    .from(chatMessages)
    .where(and(eq(chatMessages.tenantId, tenantId), eq(chatMessages.threadId, threadId)))
    .orderBy(desc(chatMessages.id))
    .limit(MESSAGE_HISTORY_LIMIT)
  return ok({ messages: rows.reverse() })
}

export async function appendMessage(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  content: ChatContent,
): Promise<MessageView> {
  const [row] = await db
    .insert(chatMessages)
    .values({ tenantId, threadId, role: content.role, content })
    .returning(messageCols)
  if (!row) throw new Error('Invariant: message insert returned no row')
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, threadId)))
  return row
}

export async function setPendingCall(db: Db, tenantId: TenantId, threadId: string, pending: PendingCall | null): Promise<void> {
  await db
    .update(chatThreads)
    .set({ pendingCall: pending, updatedAt: new Date() })
    .where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, threadId)))
}

// Takes the pending call off the thread and hands it to exactly one caller:
// a second confirmation, or a retry after the first executed, finds nothing.
export async function claimPendingCall(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  callId: string,
): Promise<PendingCall | null> {
  const [row] = await db
    .update(chatThreads)
    .set({ pendingCall: null, updatedAt: new Date() })
    .where(
      and(
        eq(chatThreads.tenantId, tenantId),
        eq(chatThreads.id, threadId),
        sql`${chatThreads.pendingCall} ->> 'callId' = ${callId}`,
      ),
    )
    .returning({ pendingCall: sql<PendingCall>`(SELECT pending_call FROM chat_threads WHERE id = ${threadId})` })
  return row?.pendingCall ?? null
}

export async function setThreadProject(db: Db, tenantId: TenantId, threadId: string, projectId: ProjectId): Promise<void> {
  await db
    .update(chatThreads)
    .set({ projectId, updatedAt: new Date() })
    .where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, threadId)))
}

// A job finished: the notice the UI shows as a card and the agent reads on
// the next turn. Silently a no-op when the thread is gone.
export async function appendJobNotice(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  notice: { jobId: string; kind: string; status: string; summary: string },
): Promise<void> {
  const thread = await getThread(db, tenantId, threadId)
  if (!thread.ok) return
  await appendMessage(db, tenantId, threadId, { role: 'job', ...notice })
}
