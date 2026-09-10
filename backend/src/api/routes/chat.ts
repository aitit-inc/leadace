import { Hono, type Context } from 'hono'
import { streamSSE } from 'hono/streaming'
import { zValidator } from '../zvalidator'
import {
  createThread,
  listThreads,
  getThread,
  deleteThread,
  listMessages,
  createThreadBodySchema,
  listThreadsQuerySchema,
  threadIdParamSchema,
  messageBodySchema,
  confirmBodySchema,
} from '../../services/chat/threads'
import { runChatTurn, type ChatTurnInput, type ChatTurnDeps } from '../../services/chat/agent'
import { buildToolExecutor, type InternalDispatch } from '../tool-executor'
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

// --- Streaming turns. These run outside rlsMiddleware: the request's RLS
// transaction would close when the handler returns the Response, while the
// stream keeps working. Persistence takes its own connection per call.

// Tool calls re-enter the API in-process as the same person, marked as the
// chat so services apply agent privileges (approved playbooks only, no
// UI-only settings).
type ChatCtx = Context<{ Bindings: Env; Variables: Variables }, string>

function streamTurn(c: ChatCtx, dispatch: InternalDispatch, threadId: string, input: ChatTurnInput) {
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const tools = buildToolExecutor(c.env, c.executionCtx, dispatch, {
    origin: 'chat',
    authorization: c.req.header('Authorization') ?? '',
    apiOrigin: new URL(c.req.url).origin,
  })
  const run: ChatTurnDeps['run'] = (fn) => withTenantConnection(c.env.DATABASE_URL, tenantId, fn)
  return streamSSE(c, async (stream) => {
    // Stop closes the connection. The runtime reports that on the request or by
    // cancelling the response; both abort the stream, which also releases a
    // write stuck on the closed connection.
    c.req.raw.signal.addEventListener('abort', () => stream.abort())
    const stop = new AbortController()
    stream.onAbort(() => stop.abort())
    // A closed connection is noticed only on a write, and nothing is written
    // while the model thinks or a tool runs.
    const ping = setInterval(() => void stream.write(': ping\n\n'), 1000)
    const deps = { run, signal: stop.signal, tenantId, userId, env: c.env, tools }
    const turn = (async () => {
      // A throw here would close the stream mid-way and read as a finished
      // turn; the client requires a terminal event, so failures become one.
      try {
        for await (const event of runChatTurn(deps, threadId, input)) {
          await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
        }
      } catch (e) {
        console.error('[chat] stream failed', e)
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: 'The turn failed part-way. Reload the thread to see what was saved.' }) })
      }
    })()
    // A closed connection ends the invocation, cutting a tool call mid-flight
    // (an email sent, never recorded); waitUntil gives the turn the platform's
    // 30 s to finish it and record where it stopped.
    c.executionCtx.waitUntil(turn)
    await turn
    clearInterval(ping)
  })
}

export function createChatStreamRouter(dispatch: InternalDispatch) {
  const router = new Hono<{ Bindings: Env; Variables: Variables }>()
  router.post(
    '/chat/threads/:id/messages',
    zValidator('param', threadIdParamSchema),
    zValidator('json', messageBodySchema),
    (c) => streamTurn(c, dispatch, c.req.valid('param').id, { kind: 'message', text: c.req.valid('json').text }),
  )
  router.post(
    '/chat/threads/:id/confirm',
    zValidator('param', threadIdParamSchema),
    zValidator('json', confirmBodySchema),
    (c) => streamTurn(c, dispatch, c.req.valid('param').id, { kind: 'confirm', ...c.req.valid('json') }),
  )
  return router
}
