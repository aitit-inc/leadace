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
import { respondWithError } from '../respond'
import { withTenantConnection } from '../../db/rls'
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
  const result = await deleteThread(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

// --- The thread runner's routes (api/thread-runner.ts). They run outside
// rlsMiddleware, each on a connection of its own: a message has to be
// committed before the runner is woken to read it.

type ChatCtx = Context<{ Bindings: Env; Variables: Variables }, string>

function ownThread(c: ChatCtx, id: string) {
  const tenantId = c.get('tenantId')
  return withTenantConnection(c.env.DATABASE_URL, tenantId, (db) => getThread(db, tenantId, id))
}

export const chatRunnerRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

chatRunnerRouter.post(
  '/chat/threads/:id/messages',
  zValidator('param', threadIdParamSchema),
  zValidator('json', messageBodySchema),
  async (c) => {
    const { id } = c.req.valid('param')
    const tenantId = c.get('tenantId')
    const message = await withTenantConnection(c.env.DATABASE_URL, tenantId, (db) => postMessage(db, tenantId, id, c.req.valid('json').text))
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
