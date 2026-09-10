// The agent's tool surface, bound to one caller. Tools reach the API the only
// way they may — a request back into this app — so building one needs the
// identity that request carries: the chat passes the signed-in person's
// Authorization through, a scheduled run mints one for the person who
// registered the schedule.
import type { ExecutionContext } from 'hono'
import type { ToolExecutor } from '../services/chat/agent'
import { buildToolRegistry, type ToolDef } from '../tools/registry'
import { buildFunctionDeclarations, parseToolArgs } from '../tools/declarations'
import { INTERNAL_DISPATCH_HEADER, INTERNAL_ORIGIN_HEADER, internalDispatchToken } from './internal-dispatch'
import type { Env } from './types'

export type InternalDispatch = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>

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

export type ToolCallerIdentity = {
  origin: string
  authorization: string
  // Where the tool's request goes; the chat reuses its own request's origin.
  apiOrigin: string
}

export function buildToolExecutor(
  env: Env,
  executionCtx: ExecutionContext,
  dispatch: InternalDispatch,
  identity: ToolCallerIdentity,
): ToolExecutor {
  const { byName, declarations } = loadTools()
  const ctx = {
    callApi: async (method: string, path: string, body: unknown) => {
      const res = await dispatch(
        new Request(`${identity.apiOrigin}/api${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: identity.authorization,
            [INTERNAL_DISPATCH_HEADER]: internalDispatchToken(),
            [INTERNAL_ORIGIN_HEADER]: identity.origin,
          },
          body: body != null ? JSON.stringify(body) : undefined,
        }),
        env,
        executionCtx,
      )
      return { ok: res.ok, status: res.status, data: (await res.json()) as unknown }
    },
  }
  return {
    declarations,
    confirmSummary: (name, args) => {
      const tool = byName.get(name)
      if (!tool?.confirm) return null
      const parsed = parseToolArgs(tool, args)
      // Arguments the schema rejects are not gated: execute answers the model
      // with the validation error instead of asking the person about nonsense.
      if (!parsed.ok) return null
      return tool.confirm(parsed.value, ctx)
    },
    isReadOnly: (name) => byName.get(name)?.readOnly ?? false,
    isGated: (name) => {
      const tool = byName.get(name)
      // An unknown tool counts as gated: nothing unnamed is pre-authorized.
      return tool === undefined || tool.confirm !== undefined
    },
    execute: async (name, args) => {
      const tool = byName.get(name)
      if (!tool) return { ok: false, text: `Unknown tool ${name}` }
      const parsed = parseToolArgs(tool, args)
      if (!parsed.ok) return { ok: false, text: `Invalid arguments: ${parsed.error}` }
      const result = await tool.handler(parsed.value, ctx)
      const text = result.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
      return { ok: !result.isError, text, ...(result.effect ? { effect: result.effect } : {}) }
    },
  }
}
