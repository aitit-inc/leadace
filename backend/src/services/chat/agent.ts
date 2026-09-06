// The chat agent turn: one person message (or one confirmation) → a streamed
// model answer with tool calls executed in between. Every exchange is
// persisted to the thread as it happens in its own short RLS transaction, so a
// dropped connection loses nothing, no connection is held across a model call,
// and a replay sees exactly what the model saw.
import type { Content, FunctionDeclaration, Part } from '@google/genai'
import type { Db } from '../../db/connection'
import { asProjectId, type TenantId } from '../../domain/ids'
import { utcDateKey } from '../../domain/time'
import { needsConfirmation, type ChatContent, type ChatModelPart, type PendingCall } from '../../domain/chat'
import type { GeminiEnv } from '../gemini'
import { GeminiError, HOSTED_MODEL, streamGeminiChat } from '../gemini'
import { takeChatRateSlot, MAIN_CHAT_TURNS_PER_TENANT_PER_DAY } from '../chat-rate-limit'
import { listProjects } from '../projects'
import { getCredentialsStatus } from '../google-auth'
import { getTenantComplianceStatus } from '../tenants'
import {
  appendMessage,
  claimPendingCall,
  getThread,
  listMessages,
  setPendingCall,
  setThreadProject,
  type MessageView,
} from './threads'
import { buildSystemInstruction } from './system-prompt'

export type ToolExecutor = {
  declarations: FunctionDeclaration[]
  execute: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string }>
}

export type ChatTurnInput =
  | { kind: 'message'; text: string }
  | { kind: 'confirm'; callId: string; approve: boolean }

export type ChatEvent =
  | { type: 'message'; message: MessageView }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; text: string }
  | { type: 'confirm_required'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'job_started'; jobId: string; kind: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// Each persistence call runs inside `run` — one short RLS transaction.
// `aborted` is the client connection: once it is gone no further model round
// or tool call starts; what already ran is still recorded.
export type ChatTurnDeps = {
  run: <T>(fn: (db: Db) => Promise<T>) => Promise<T>
  aborted: () => boolean
  tenantId: TenantId
  userId: string
  env: GeminiEnv & { APP_URL: string }
  tools: ToolExecutor
}

const MAX_TOOL_ROUNDS = 12

type ToolResult = { ok: boolean; text: string }
type Call = { id: string; name: string; args: Record<string, unknown> }
type ToolResponse = { id: string; name: string; response: Record<string, unknown> }
type ToolPart = { functionResponse: ToolResponse }

function toolResponse(call: Call, result: ToolResult): ToolResponse {
  return { id: call.id, name: call.name, response: result.ok ? { result: result.text } : { error: result.text } }
}

const DECLINED: ToolResult = { ok: false, text: 'The person declined this call.' }
const SUPERSEDED: ToolResult = { ok: false, text: 'The person did not approve this call and continued the conversation.' }

const INTERRUPTED: ToolResult = { ok: false, text: 'This call was interrupted before it produced a result.' }

// The history as the model must see it: every functionCall answered by a
// functionResponse in the very next content. A call left unanswered (a turn
// that died mid-tool, a job notice landing while a call awaited approval, the
// history window cutting between the two) gets a synthetic error response,
// so one bad exchange never makes the thread unusable.
export function toContents(messages: MessageView[]): Content[] {
  const contents: Content[] = []
  let open: Call[] = []
  const deferred: Content[] = []
  const answerOpen = (answered: ToolPart[]) => {
    const openIds = new Set(open.map((c) => c.id))
    const matched = answered.filter((p) => openIds.has(p.functionResponse.id))
    const ids = new Set(matched.map((p) => p.functionResponse.id))
    const missing = open.filter((c) => !ids.has(c.id)).map((c) => ({ functionResponse: toolResponse(c, INTERRUPTED) }))
    contents.push({ role: 'user', parts: [...matched, ...missing] })
    contents.push(...deferred.splice(0))
    open = []
  }
  for (const m of messages) {
    const c = m.content
    switch (c.role) {
      case 'user':
        if (open.length > 0) answerOpen([])
        contents.push({ role: 'user', parts: c.parts })
        break
      case 'model':
        if (open.length > 0) answerOpen([])
        contents.push({ role: 'model', parts: c.parts as Part[] })
        open = c.parts.flatMap((p) => ('functionCall' in p ? [{ id: p.functionCall.id, name: p.functionCall.name, args: p.functionCall.args }] : []))
        break
      case 'tool':
        // A response with no call to answer (window cut, a turn that raced
        // another) has no place in what the model may see.
        if (open.length > 0) answerOpen(c.parts as ToolPart[])
        break
      case 'job': {
        const notice: Content = { role: 'user', parts: [{ text: `[system] Job ${c.kind} ${c.jobId} ${c.status}: ${c.summary}` }] }
        if (open.length > 0) deferred.push(notice)
        else contents.push(notice)
        break
      }
    }
  }
  if (open.length > 0) answerOpen([])
  return contents
}

const STARTED_JOB = /^Started: (\S+) (\S+) /
const CREATED_PROJECT = /created \(id: ([A-Za-z0-9]+)\)/

async function buildContext(deps: ChatTurnDeps, threadProjectId: string | null): Promise<string> {
  const [projects, gmail, compliance] = await deps.run((db) =>
    Promise.all([
      listProjects(db, deps.tenantId),
      getCredentialsStatus(db, deps.tenantId, deps.userId),
      getTenantComplianceStatus(db, deps.tenantId),
    ]),
  )
  return buildSystemInstruction({
    today: utcDateKey(),
    projects: projects.ok ? projects.value.projects.map((p) => ({ id: p.id, name: p.name })) : [],
    threadProjectId,
    gmail: gmail.ok ? (gmail.value.connected ? `connected as ${gmail.value.email}` : 'not connected — connect it at the Web UI top banner') : 'unknown',
    compliance: compliance.ok ? (compliance.value.ready ? 'ready' : `missing ${compliance.value.missing.join(', ')} — set on /workspace-settings`) : 'unknown',
    appUrl: deps.env.APP_URL,
  })
}

function withThread(call: Call, threadId: string): Record<string, unknown> {
  return call.name === 'start_job' ? { ...call.args, threadId } : call.args
}

// Runs one call and yields its events; side effects some tools imply (a job
// started, a project created in this thread) are applied here.
async function* executeCall(deps: ChatTurnDeps, threadId: string, call: Call): AsyncGenerator<ChatEvent, ToolResult> {
  yield { type: 'tool_call', callId: call.id, name: call.name, args: call.args }
  // A tool that throws (dispatch failure, non-JSON body) is an error result
  // for the model, not the end of the turn.
  const result = await deps.tools.execute(call.name, withThread(call, threadId)).catch((e: unknown) => {
    console.error(`[chat] tool ${call.name} threw`, e)
    return { ok: false, text: `Tool failed: ${e instanceof Error ? e.message : String(e)}` }
  })
  yield { type: 'tool_result', callId: call.id, name: call.name, ok: result.ok, text: result.text }
  if (result.ok && call.name === 'start_job') {
    const m = STARTED_JOB.exec(result.text)
    if (m) yield { type: 'job_started', jobId: m[1]!, kind: m[2]! }
  }
  if (result.ok && call.name === 'setup_project') {
    const m = CREATED_PROJECT.exec(result.text)
    if (m) await deps.run((db) => setThreadProject(db, deps.tenantId, threadId, asProjectId(m[1]!)))
  }
  return result
}

// Every gated call in a model turn waits for the person, one at a time; the
// ungated ones run now. Returns the tool message when nothing is pending.
async function* settleCalls(
  deps: ChatTurnDeps,
  threadId: string,
  modelMessageId: number,
  calls: Call[],
): AsyncGenerator<ChatEvent, ToolPart[] | { pending: PendingCall }> {
  const responses: ToolResponse[] = []
  const gated: Call[] = []
  for (const call of calls) {
    if (deps.aborted()) {
      responses.push(toolResponse(call, INTERRUPTED))
      continue
    }
    if (needsConfirmation(call.name, call.args)) {
      gated.push(call)
      continue
    }
    const result = yield* executeCall(deps, threadId, call)
    responses.push(toolResponse(call, result))
  }
  const [first, ...rest] = gated
  if (first && !deps.aborted()) {
    return {
      pending: {
        messageId: modelMessageId,
        callId: first.id,
        name: first.name,
        args: first.args,
        otherResponses: responses,
        remaining: rest.map((c) => ({ callId: c.id, name: c.name, args: c.args })),
      },
    }
  }
  return responses.map((r) => ({ functionResponse: r }))
}

async function* persistTool(deps: ChatTurnDeps, threadId: string, parts: ToolPart[]): AsyncGenerator<ChatEvent, void> {
  const msg = await deps.run((db) => appendMessage(db, deps.tenantId, threadId, { role: 'tool', parts }))
  yield { type: 'message', message: msg }
}

async function* holdPending(deps: ChatTurnDeps, threadId: string, pending: PendingCall): AsyncGenerator<ChatEvent, void> {
  await deps.run((db) => setPendingCall(db, deps.tenantId, threadId, pending))
  yield { type: 'confirm_required', callId: pending.callId, name: pending.name, args: pending.args }
  yield { type: 'done' }
}

export async function* runChatTurn(deps: ChatTurnDeps, threadId: string, input: ChatTurnInput): AsyncGenerator<ChatEvent> {
  const thread = await deps.run((db) => getThread(db, deps.tenantId, threadId))
  if (!thread.ok) {
    yield { type: 'error', message: thread.error }
    return
  }

  if (input.kind === 'message') {
    const slot = await deps.run((db) => takeChatRateSlot(db, deps.tenantId, 'main_chat', deps.tenantId))
    if (!slot) {
      yield { type: 'error', message: `Daily chat limit reached (${MAIN_CHAT_TURNS_PER_TENANT_PER_DAY} turns) — resets at midnight UTC.` }
      return
    }
    // A new message while calls await approval is the answer "no" to all of them.
    const p = thread.value.pendingCall
    if (p) {
      const claimed = await deps.run((db) => claimPendingCall(db, deps.tenantId, threadId, p.callId))
      if (claimed) {
        const declined: ToolPart[] = [
          ...claimed.otherResponses.map((r) => ({ functionResponse: r })),
          { functionResponse: toolResponse({ id: claimed.callId, name: claimed.name, args: claimed.args }, SUPERSEDED) },
          ...claimed.remaining.map((c) => ({ functionResponse: toolResponse({ id: c.callId, name: c.name, args: c.args }, SUPERSEDED) })),
        ]
        yield* persistTool(deps, threadId, declined)
      }
    }
    const userMsg = await deps.run((db) => appendMessage(db, deps.tenantId, threadId, { role: 'user', parts: [{ text: input.text }] }))
    yield { type: 'message', message: userMsg }
  } else {
    // The claim is the only path to execution: a concurrent or repeated
    // confirmation finds nothing to run.
    const claimed = await deps.run((db) => claimPendingCall(db, deps.tenantId, threadId, input.callId))
    if (!claimed) {
      yield { type: 'error', message: 'No call is awaiting confirmation.' }
      return
    }
    const call: Call = { id: claimed.callId, name: claimed.name, args: claimed.args }
    const result = input.approve ? yield* executeCall(deps, threadId, call) : DECLINED
    const answered = [...claimed.otherResponses, toolResponse(call, result)]
    const [next, ...rest] = claimed.remaining
    if (next) {
      yield* holdPending(deps, threadId, {
        messageId: claimed.messageId,
        callId: next.callId,
        name: next.name,
        args: next.args,
        otherResponses: answered,
        remaining: rest,
      })
      return
    }
    yield* persistTool(deps, threadId, answered.map((r) => ({ functionResponse: r })))
  }

  const systemInstruction = await buildContext(deps, thread.value.projectId)
  const history = await deps.run((db) => listMessages(db, deps.tenantId, threadId))
  if (!history.ok) {
    yield { type: 'error', message: history.error }
    return
  }
  const contents = toContents(history.value.messages)

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let text = ''
    const calls: Array<Call & { thoughtSignature?: string }> = []
    try {
      for await (const chunk of streamGeminiChat({
        apiKey: deps.env.GEMINI_API_KEY,
        model: HOSTED_MODEL,
        systemInstruction,
        contents,
        functionDeclarations: deps.tools.declarations,
        thinking: 'LOW',
        maxOutputTokens: 8192,
      })) {
        for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
          if (part.thought) continue
          if (part.text) {
            text += part.text
            yield { type: 'text_delta', text: part.text }
          }
          if (part.functionCall?.name) {
            calls.push({
              // A confirmation is keyed by this id, so it must never repeat across turns.
              id: part.functionCall.id ?? `call_${crypto.randomUUID()}`,
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
            })
          }
        }
      }
    } catch (e) {
      if (!(e instanceof GeminiError)) console.error('[chat] turn failed', e)
      yield {
        type: 'error',
        message: e instanceof GeminiError ? `The model is unavailable right now (${e.message}). Try again in a moment.` : 'Unexpected error.',
      }
      return
    }

    const modelParts: ChatModelPart[] = [
      ...(text ? [{ text }] : []),
      ...calls.map(({ thoughtSignature, ...c }) => ({ functionCall: c, ...(thoughtSignature ? { thoughtSignature } : {}) })),
    ]
    if (modelParts.length === 0) break
    const modelMsg = await deps.run((db) => appendMessage(db, deps.tenantId, threadId, { role: 'model', parts: modelParts }))
    yield { type: 'message', message: modelMsg }
    contents.push({ role: 'model', parts: modelParts as Part[] })
    if (calls.length === 0) break

    const settled = yield* settleCalls(deps, threadId, modelMsg.id, calls)
    if ('pending' in settled) {
      yield* holdPending(deps, threadId, settled.pending)
      return
    }
    const toolContent: ChatContent = { role: 'tool', parts: settled }
    yield* persistTool(deps, threadId, settled)
    contents.push({ role: 'user', parts: toolContent.parts })
    if (deps.aborted()) return
  }
  yield { type: 'done' }
}
