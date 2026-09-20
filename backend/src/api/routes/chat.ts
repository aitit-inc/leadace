import { Hono, type Context } from 'hono'
import { zValidator } from '../zvalidator'
import {
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listMessages,
  postMessage,
  createThreadBodySchema,
  listThreadsQuerySchema,
  threadIdParamSchema,
  messageBodySchema,
  confirmBodySchema,
} from '../../services/chat/threads'
import {
  attachmentIdParamSchema,
  deleteThreadAttachments,
  readAttachment,
  resolveAttachments,
  uploadAttachment,
  uploadAttachmentQuerySchema,
} from '../../services/chat/attachments'
import { respondWithError } from '../respond'
import { withTenantConnection, type TenantRun } from '../../db/rls'
import type { Env, Variables } from '../types'

export const chatRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

chatRouter.post('/chat/threads', zValidator('json', createThreadBodySchema), async (c) => {
  const result = await createThread(c.get('db'), c.get('tenantId'), c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

chatRouter.get('/chat/threads', zValidator('query', listThreadsQuerySchema), async (c) => {
  const result = await listThreads(c.get('db'), c.get('tenantId'), c.req.valid('query'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

chatRouter.get('/chat/threads/:id', zValidator('param', threadIdParamSchema), async (c) => {
  const [thread, messages] = await Promise.all([
    getThread(c.get('db'), c.get('tenantId'), c.req.valid('param').id),
    listMessages(c.get('db'), c.get('tenantId'), c.req.valid('param').id),
  ])
  if (!thread.ok) return respondWithError(c, thread)
  if (!messages.ok) return respondWithError(c, messages)
  return c.json({ thread: thread.value, messages: messages.value.messages })
})

chatRouter.delete('/chat/threads/:id', zValidator('param', threadIdParamSchema), async (c) => {
  const tenantId = c.get('tenantId')
  const { id } = c.req.valid('param')
  const result = await deleteThread(c.get('db'), tenantId, id)
  if (!result.ok) return respondWithError(c, result)
  // No cascade reaches the bucket. A failure here rolls the row back with the
  // request, so a retry takes both.
  await deleteThreadAttachments(c.env, tenantId, id)
  return c.json(result.value)
})

// --- The thread runner's routes (api/thread-runner.ts). They run outside
// rlsMiddleware, each on a connection of its own: a message has to be
// committed before the runner is woken to read it.

type ChatCtx = Context<{ Bindings: Env; Variables: Variables }, string>

function tenantRun(c: ChatCtx): TenantRun {
  return (fn) => withTenantConnection(c.env.DATABASE_URL, c.get('tenantId'), fn)
}

function ownThread(c: ChatCtx, id: string) {
  const tenantId = c.get('tenantId')
  return withTenantConnection(c.env.DATABASE_URL, tenantId, (db) => getThread(db, tenantId, id))
}

export const chatRunnerRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// Attachments sit with the runner's routes: the upload waits on the model
// provider, and no request connection may be held across that.
chatRunnerRouter.post(
  '/chat/threads/:id/attachments',
  zValidator('param', threadIdParamSchema),
  zValidator('query', uploadAttachmentQuerySchema),
  async (c) => {
    const { id } = c.req.valid('param')
    const thread = await ownThread(c, id)
    if (!thread.ok) return respondWithError(c, thread)
    const result = await uploadAttachment(tenantRun(c), c.get('tenantId'), c.env, id, c.req.valid('query'), c.req.raw.body)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)

chatRunnerRouter.get('/chat/threads/:id/attachments/:attachmentId', zValidator('param', attachmentIdParamSchema), async (c) => {
  const { id, attachmentId } = c.req.valid('param')
  const thread = await ownThread(c, id)
  if (!thread.ok) return respondWithError(c, thread)
  const object = await readAttachment(c.env, c.get('tenantId'), id, attachmentId)
  if (!object) return c.json({ error: 'Attachment not found' }, 404)
  return c.body(object.body, 200, {
    'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(object.customMetadata?.name ?? attachmentId)}`,
  })
})

chatRunnerRouter.post(
  '/chat/threads/:id/messages',
  zValidator('param', threadIdParamSchema),
  zValidator('json', messageBodySchema),
  async (c) => {
    const { id } = c.req.valid('param')
    const tenantId = c.get('tenantId')
    const { text, attachmentIds } = c.req.valid('json')
    const files = await resolveAttachments(c.env, tenantId, id, attachmentIds)
    if (!files.ok) return respondWithError(c, files)
    const message = await withTenantConnection(c.env.DATABASE_URL, tenantId, (db) => postMessage(db, tenantId, id, text, files.value))
    if (!message.ok) return respondWithError(c, message)
    await c.env.THREADS.getByName(id).wake({ tenantId, threadId: id })
    return c.json(message.value, 201)
  },
)

chatRunnerRouter.post(
  '/chat/threads/:id/confirm',
  zValidator('param', threadIdParamSchema),
  zValidator('json', confirmBodySchema),
  async (c) => {
    const { id } = c.req.valid('param')
    const thread = await ownThread(c, id)
    if (!thread.ok) return respondWithError(c, thread)
    const { callId, approve } = c.req.valid('json')
    await c.env.THREADS.getByName(id).confirm({ tenantId: c.get('tenantId'), threadId: id }, callId, approve)
    return c.body(null, 204)
  },
)

chatRunnerRouter.post('/chat/threads/:id/stop', zValidator('param', threadIdParamSchema), async (c) => {
  const { id } = c.req.valid('param')
  const thread = await ownThread(c, id)
  if (!thread.ok) return respondWithError(c, thread)
  await c.env.THREADS.getByName(id).halt({ tenantId: c.get('tenantId'), threadId: id })
  return c.body(null, 204)
})

// The thread's live feed: a WebSocket the runner holds while the thread is open.
chatRunnerRouter.get('/chat/threads/:id/live', zValidator('param', threadIdParamSchema), async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') return c.json({ error: 'Expected a WebSocket upgrade' }, 426)
  const { id } = c.req.valid('param')
  const thread = await ownThread(c, id)
  if (!thread.ok) return respondWithError(c, thread)
  const res = await c.env.THREADS.getByName(id).fetch(c.req.raw)
  // A fetched response's headers are immutable, and CORS adds to them.
  return new Response(null, { status: res.status, headers: res.headers, webSocket: res.webSocket })
})
