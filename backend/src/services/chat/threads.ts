// Chat threads and messages: the hosted agent's conversation store. The agent
// loop (services/chat/agent.ts) reads and appends here; jobs append their
// completion notices here; the Web UI lists and reads here.
import { z } from 'zod'
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'
import type { Db } from '../../db/connection'
import { chatMessages, chatThreads } from '../../db/schema'
import type { ChatContent, ChatRole, ChatUserPart, PendingCall } from '../../domain/chat'
import { attachmentIdsSchema, type FileRef } from '../../domain/chat-attachment'
import type { JobOrigin } from '../../domain/jobs'
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

export const messageBodySchema = z
  .object({ text: z.string().max(8000), attachmentIds: attachmentIdsSchema.default([]) })
  .strict()
  .refine((b) => b.text.trim() !== '' || b.attachmentIds.length > 0, { message: 'Write something or attach a file' })
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
  readAfter: number | null
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
  readAfter: chatMessages.readAfter,
  createdAt: chatMessages.createdAt,
}

function toThreadView(row: typeof chatThreads.$inferSelect extends infer R ? Omit<R, 'tenantId'> : never): ThreadView {
  // A call held before approval cards carried their summary has nothing to
  // show, so it is not offered; the next message supersedes it.
  const pendingCall = row.pendingCall?.summary ? row.pendingCall : null
  return { ...row, pendingCall, projectId: row.projectId === null ? null : asProjectId(row.projectId) }
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

const DEFAULT_THREAD_TITLE = 'New chat'
const TITLE_MAX_CHARS = 60

// Empty when there is nothing to name the thread with; the caller then keeps
// the default.
export function titleFromMessage(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length <= TITLE_MAX_CHARS ? line : `${line.slice(0, TITLE_MAX_CHARS - 1)}…`
}

async function renameThread(db: Db, tenantId: TenantId, threadId: string, title: string): Promise<void> {
  await db
    .update(chatThreads)
    .set({ title })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.tenantId, tenantId)))
}

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
    .values({ id: randomFromAlphabet(ID_ALPHABET, 21), tenantId, projectId, title: body.title ?? DEFAULT_THREAD_TITLE, createdAt: now, updatedAt: now })
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

// A row the agent reads where it lands: its own messages and tool results, a
// schedule's instruction.
export function appendMessage(db: Db, tenantId: TenantId, threadId: string, content: ChatContent): Promise<MessageView> {
  return insertMessage(db, tenantId, threadId, content, 0)
}

// A null `readAfter` leaves the row for the agent to read (hasUnanswered).
async function insertMessage(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  content: ChatContent,
  readAfter: number | null,
): Promise<MessageView> {
  const [row] = await db
    .insert(chatMessages)
    .values({ tenantId, threadId, role: content.role, content, readAfter })
    .returning(messageCols)
  if (!row) throw new Error('Invariant: message insert returned no row')
  await db.update(chatThreads).set({ updatedAt: new Date() }).where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, threadId)))
  return row
}

// A person's message. The first one names the thread. One sent while calls
// await approval is the answer "no" to all of them; one sent before the card
// came up is not, and waits behind it (hasUnanswered).
export async function postMessage(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  text: string,
  files: FileRef[],
): Promise<ServiceResult<MessageView>> {
  const thread = await getThread(db, tenantId, threadId)
  if (!thread.ok) return thread
  const title = thread.value.title === DEFAULT_THREAD_TITLE ? titleFromMessage(text || (files[0]?.name ?? '')) : ''
  if (title) await renameThread(db, tenantId, threadId, title)
  await supersedePendingCall(db, tenantId, threadId)
  // Files first: the model sees the material before the ask.
  const parts: ChatUserPart[] = [...files.map((file) => ({ file })), ...(text ? [{ text }] : [])]
  return ok(await insertMessage(db, tenantId, threadId, { role: 'user', parts }, null))
}

const SUPERSEDED = { error: 'The person did not approve this call and continued the conversation.' }

// Answers the call awaiting approval, and the rest of its model turn, as not
// approved. A call held before cards carried a summary goes the same way.
async function supersedePendingCall(db: Db, tenantId: TenantId, threadId: string): Promise<void> {
  const [row] = await db
    .update(chatThreads)
    .set({ pendingCall: null })
    .where(and(eq(chatThreads.tenantId, tenantId), eq(chatThreads.id, threadId), isNotNull(chatThreads.pendingCall)))
    .returning({ pendingCall: sql<PendingCall>`(SELECT pending_call FROM chat_threads WHERE id = ${threadId})` })
  const p = row?.pendingCall
  if (!p) return
  const declined = (id: string, name: string) => ({ functionResponse: { id, name, response: SUPERSEDED } })
  await appendMessage(db, tenantId, threadId, {
    role: 'tool',
    parts: [...p.otherResponses.map((r) => ({ functionResponse: r })), declined(p.callId, p.name), ...p.remaining.map((c) => declined(c.callId, c.name))],
  })
}

// The agent read this window of the thread, so its unread rows are read after
// the window's last message: those it saw by id, since a row committed after
// the read can carry a lower one, and any older than the window, which the
// model will never see.
export async function markRead(db: Db, tenantId: TenantId, threadId: string, window: MessageView[]): Promise<void> {
  const first = window[0]
  const last = window.at(-1)
  if (!first || !last) return
  const seen = window.filter((m) => m.readAfter === null).map((m) => m.id)
  await db
    .update(chatMessages)
    .set({ readAfter: last.id })
    .where(
      and(
        eq(chatMessages.tenantId, tenantId),
        eq(chatMessages.threadId, threadId),
        isNull(chatMessages.readAfter),
        or(inArray(chatMessages.id, seen), lt(chatMessages.id, first.id)),
      ),
    )
}

// Whether the agent owes the thread a turn: an input is still unread. None is
// while a call awaits approval; inputs wait behind the person's answer.
export async function hasUnanswered(db: Db, tenantId: TenantId, threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(
      and(
        eq(chatMessages.tenantId, tenantId),
        eq(chatMessages.threadId, threadId),
        isNull(chatMessages.readAfter),
        isNull(chatThreads.pendingCall),
      ),
    )
    .limit(1)
  return row !== undefined
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

// A job finished: the notice the UI shows as a card. The agent answers it only
// for a job the conversation started; a schedule's jobs are its log, not
// questions. Silently a no-op when the thread is gone.
export async function appendJobNotice(
  db: Db,
  tenantId: TenantId,
  threadId: string,
  notice: { jobId: string; kind: string; status: string; summary: string },
  startedBy: JobOrigin,
): Promise<void> {
  const thread = await getThread(db, tenantId, threadId)
  if (!thread.ok) return
  await insertMessage(db, tenantId, threadId, { role: 'job', ...notice }, startedBy === 'chat' ? null : 0)
}
