import { Hono, type Context, type ExecutionContext } from 'hono'
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
import { runChatTurn, type ToolExecutor, type ChatTurnInput } from '../../services/chat/agent'
import { buildToolRegistry, type ToolDef } from '../../tools/registry'
import { buildFunctionDeclarations, parseToolArgs } from '../../tools/declarations'
import { respondWithError } from '../respond'
import { runWithRls } from '../../db/rls'
import { INTERNAL_DISPATCH_HEADER, internalDispatchToken } from '../internal-dispatch'
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
// stream keeps working. The agent opens a short RLS transaction per
// persistence call instead, so no connection is held across a model call.

export type InternalDispatch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

// Tool calls re-enter the API in-process as the same person, marked as the
// chat so services apply agent privileges (approved playbooks only, no
// UI-only settings).
type ChatCtx = Context<{ Bindings: Env; Variables: Variables }, string>

// The registry and its function declarations never change per request.
type Tools = { byName: Map<string, ToolDef>; declarations: ReturnType<typeof buildFunctionDeclarations> }
let tools: Tools | null = null
function loadTools(): Tools {
  if (!tools) {
    const registry = buildToolRegistry()
    tools = { byName: new Map(registry.map((t) => [t.name, t])), declarations: buildFunctionDeclarations(registry) }
  }
  return tools
}

function toolExecutor(c: ChatCtx, dispatch: InternalDispatch): ToolExecutor {
  const { byName, declarations } = loadTools()
  const internalFetch = (request: Request) => dispatch(request, c.env, c.executionCtx)
  const origin = new URL(c.req.url).origin
  const authorization = c.req.header('Authorization') ?? ''
  const ctx = {
    callApi: async (method: string, path: string, body: unknown) => {
      const res = await internalFetch(
        new Request(`${origin}/api${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: authorization, [INTERNAL_DISPATCH_HEADER]: internalDispatchToken() },
          body: body != null ? JSON.stringify(body) : undefined,
        }),
      )
      return { ok: res.ok, status: res.status, data: (await res.json()) as unknown }
    },
  }
  return {
    declarations,
    execute: async (name, args) => {
      const tool = byName.get(name)
      if (!tool) return { ok: false, text: `Unknown tool ${name}` }
      const parsed = parseToolArgs(tool, args)
      if (!parsed.ok) return { ok: false, text: `Invalid arguments: ${parsed.error}` }
      const result = await tool.handler(parsed.value, ctx)
      const text = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
      return { ok: !result.isError, text }
    },
  }
}

function streamTurn(c: ChatCtx, dispatch: InternalDispatch, threadId: string, input: ChatTurnInput) {
  const db = c.get('db')
  const tenantId = c.get('tenantId')
  const userId = c.get('userId')
  const tools = toolExecutor(c, dispatch)
  const run = <T>(fn: (tx: typeof db) => Promise<T>) => runWithRls(db, tenantId, fn)
  return streamSSE(c, async (stream) => {
    // A throw here would close the stream mid-way and read as a finished
    // turn; the client requires a terminal event, so failures become one.
    try {
      const deps = { run, aborted: () => stream.aborted, tenantId, userId, env: c.env, tools }
      for await (const event of runChatTurn(deps, threadId, input)) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) })
      }
    } catch (e) {
      console.error('[chat] stream failed', e)
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', message: 'The turn failed part-way. Reload the thread to see what was saved.' }) })
    }
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
