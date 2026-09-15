// The chat agent turn: what arrived since the agent last read the thread (or
// one confirmation, or a schedule's instruction) → a streamed model answer
// with tool calls executed in between. Every exchange is
// persisted to the thread as it happens in its own short RLS transaction, so a
// dropped connection loses nothing, no connection is held across a model call,
// and a replay sees exactly what the model saw.
import type { Content, FunctionDeclaration, Part } from '@google/genai'
import type { Db } from '../../db/connection'
import { asProjectId, type TenantId } from '../../domain/ids'
import { utcDateKey } from '../../domain/time'
import type { ChatModelPart, ConfirmSummary, PendingCall, ToolEffect } from '../../domain/chat'
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
  markRead,
  setPendingCall,
  setThreadProject,
  type MessageView,
} from './threads'
import { buildSystemInstruction } from './system-prompt'

export type ToolExecutor = {
  declarations: FunctionDeclaration[]
  // The approval card for a call that must not run unattended, or null.
  confirmSummary: (name: string, args: Record<string, unknown>) => Promise<ConfirmSummary | null> | ConfirmSummary | null
  isReadOnly: (name: string) => boolean
  // Whether the tool can raise an approval card at all, whatever its
  // arguments. The unattended policy keys on this, never on one call's card.
  isGated: (name: string) => boolean
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
}

export type ChatTurnInput =
  // Everything that arrived since the agent last read the thread: the person's
  // messages, job notices (api/thread-runner.ts decides when there is any).
  | { kind: 'unread' }
  | { kind: 'confirm'; callId: string; approve: boolean }
  // A scheduled run's instruction, already in the thread: no one can answer an
  // approval card, and the turn sees the instruction and nothing else. The
  // thread is that run's log, not its memory — day 300 must behave like day 1,
  // and what earlier runs left behind is in the database, where the tools read it.
  | { kind: 'instruction'; message: MessageView }

export type ChatEvent =
  | { type: 'message'; message: MessageView }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; callId: string; name: string; ok: boolean; text: string }
  | { type: 'confirm_required'; callId: string; summary: ConfirmSummary }
  | { type: 'job_started'; jobId: string; kind: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

// Each persistence call runs inside `run` — one short RLS transaction.
// `signal` is Stop: a tool call already running finishes, nothing further
// starts, and what ran is recorded.
export type ChatTurnDeps = {
  run: <T>(fn: (db: Db) => Promise<T>) => Promise<T>
  signal: AbortSignal
  tenantId: TenantId
  userId: string
  env: GeminiEnv & { APP_URL: string }
  tools: ToolExecutor
}

const MAX_TOOL_ROUNDS = 12

type ToolResult = { ok: boolean; text: string; effect?: ToolEffect }
type Call = { id: string; name: string; args: Record<string, unknown> }
type ToolResponse = { id: string; name: string; response: Record<string, unknown> }
type ToolPart = { functionResponse: ToolResponse }

function toolResponse(call: Call, result: ToolResult): ToolResponse {
  return { id: call.id, name: call.name, response: result.ok ? { result: result.text } : { error: result.text } }
}

// What the person actually answered. Facts that only drift (a quota ticking
// down) are not the promise, and re-asking on those would be noise.
export function termsChanged(shown: ConfirmSummary, now: ConfirmSummary): boolean {
  return shown.confirmLabel !== now.confirmLabel || shown.warning !== now.warning
}

const DECLINED: ToolResult = { ok: false, text: 'The person declined this call.' }

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

// The order the model reads the thread in. Rows are stored as they land, so a
// message that arrived while a turn ran sits before that turn's answer. Each
// goes where the agent read it (after `readAfter`), and what it has not read
// yet goes last, where the model answers it.
export function inReadingOrder(messages: MessageView[]): MessageView[] {
  const at = (m: MessageView) => (m.readAfter === null ? Infinity : Math.max(m.readAfter, m.id))
  const isInput = (m: MessageView) => m.role === 'user' || m.role === 'job'
  return [...messages].sort((a, b) => at(a) - at(b) || Number(isInput(a)) - Number(isInput(b)) || a.id - b.id)
}

async function buildContext(deps: ChatTurnDeps, threadProjectId: string | null, unattended: boolean): Promise<string> {
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
    unattended,
  })
}

function withThread(call: Call, threadId: string): Record<string, unknown> {
  return call.name === 'start_job' ? { ...call.args, threadId } : call.args
}

// A tool that throws (dispatch failure, non-JSON body) is an error result
// for the model, not the end of the turn.
function runCall(deps: ChatTurnDeps, threadId: string, call: Call): Promise<ToolResult> {
  return deps.tools.execute(call.name, withThread(call, threadId)).catch((e: unknown): ToolResult => {
    console.error(`[chat] tool ${call.name} threw`, e)
    return { ok: false, text: `Tool failed: ${e instanceof Error ? e.message : String(e)}` }
  })
}

async function* reportCall(deps: ChatTurnDeps, threadId: string, call: Call, result: ToolResult): AsyncGenerator<ChatEvent, void> {
  yield { type: 'tool_result', callId: call.id, name: call.name, ok: result.ok, text: result.text }
  const effect = result.effect
  switch (effect?.kind) {
    case 'job_started':
      yield { type: 'job_started', jobId: effect.jobId, kind: effect.jobKind }
      break
    case 'project_created':
      await deps.run((db) => setThreadProject(db, deps.tenantId, threadId, asProjectId(effect.projectId)))
      break
  }
}

async function* executeCall(deps: ChatTurnDeps, threadId: string, call: Call): AsyncGenerator<ChatEvent, ToolResult> {
  yield { type: 'tool_call', callId: call.id, name: call.name, args: call.args }
  // Stop may have come while the yield waited on the client.
  if (deps.signal.aborted) return INTERRUPTED
  const result = await runCall(deps, threadId, call)
  yield* reportCall(deps, threadId, call, result)
  return result
}

// The model chooses how many calls a turn makes; each one opens its own
// connection and RLS transaction, so the fan-out is capped here, not there.
const READ_BATCH = 4

// Every gated call in a model turn waits for the person, one at a time; the
// ungated ones run now.
async function* settleCalls(
  deps: ChatTurnDeps,
  threadId: string,
  modelMessageId: number,
  calls: Call[],
): AsyncGenerator<ChatEvent, ToolPart[] | { pending: PendingCall }> {
  // One write in the batch and the whole turn stays sequential: order is part
  // of what a write means, and a gate has to hold the turn where it sits.
  if (calls.length > 1 && !deps.signal.aborted && calls.every((c) => deps.tools.isReadOnly(c.name))) {
    for (const call of calls) yield { type: 'tool_call', callId: call.id, name: call.name, args: call.args }
    // The yields above waited on the client, who may have left during them.
    if (deps.signal.aborted) return calls.map((call) => ({ functionResponse: toolResponse(call, INTERRUPTED) }))
    const done: Array<{ call: Call; result: ToolResult }> = []
    for (let i = 0; i < calls.length; i += READ_BATCH) {
      const slice = calls.slice(i, i + READ_BATCH)
      done.push(...(await Promise.all(slice.map(async (call) => ({ call, result: deps.signal.aborted ? INTERRUPTED : await runCall(deps, threadId, call) })))))
    }
    for (const { call, result } of done) yield* reportCall(deps, threadId, call, result)
    return done.map(({ call, result }) => ({ functionResponse: toolResponse(call, result) }))
  }
  const responses: ToolResponse[] = []
  const gated: Array<Call & { summary: ConfirmSummary }> = []
  for (const call of calls) {
    if (deps.signal.aborted) {
      responses.push(toolResponse(call, INTERRUPTED))
      continue
    }
    const summary = await deps.tools.confirmSummary(call.name, call.args)
    if (summary) {
      gated.push({ ...call, summary })
      continue
    }
    const result = yield* executeCall(deps, threadId, call)
    responses.push(toolResponse(call, result))
  }
  const [first, ...rest] = gated
  if (first && !deps.signal.aborted) {
    return {
      pending: {
        messageId: modelMessageId,
        callId: first.id,
        name: first.name,
        args: first.args,
        summary: first.summary,
        otherResponses: responses,
        remaining: rest.map((c) => ({ callId: c.id, name: c.name, args: c.args, summary: c.summary })),
      },
    }
  }
  return [...responses, ...gated.map((c) => toolResponse(c, INTERRUPTED))].map((r) => ({ functionResponse: r }))
}

async function* persistTool(deps: ChatTurnDeps, threadId: string, parts: ToolPart[]): AsyncGenerator<ChatEvent, void> {
  const msg = await deps.run((db) => appendMessage(db, deps.tenantId, threadId, { role: 'tool', parts }))
  yield { type: 'message', message: msg }
}

async function* holdPending(deps: ChatTurnDeps, threadId: string, pending: PendingCall): AsyncGenerator<ChatEvent, void> {
  await deps.run((db) => setPendingCall(db, deps.tenantId, threadId, pending))
  yield { type: 'confirm_required', callId: pending.callId, summary: pending.summary }
  yield { type: 'done' }
}

export async function* runChatTurn(deps: ChatTurnDeps, threadId: string, input: ChatTurnInput): AsyncGenerator<ChatEvent> {
  const thread = await deps.run((db) => getThread(db, deps.tenantId, threadId))
  if (!thread.ok) {
    yield { type: 'error', message: thread.error }
    return
  }

  if (input.kind === 'confirm') {
    // The claim is the only path to execution: a concurrent or repeated
    // confirmation finds nothing to run.
    const claimed = await deps.run((db) => claimPendingCall(db, deps.tenantId, threadId, input.callId))
    if (!claimed) {
      yield { type: 'error', message: 'No call is awaiting confirmation.' }
      return
    }
    const call: Call = { id: claimed.callId, name: claimed.name, args: claimed.args }
    // The card was a promise made when it was shown; if the world moved under
    // it, the new terms go back to the person instead of running.
    if (input.approve) {
      const fresh = await deps.tools.confirmSummary(call.name, call.args)
      if (fresh && termsChanged(claimed.summary, fresh) && !deps.signal.aborted) {
        yield* holdPending(deps, threadId, { ...claimed, summary: fresh })
        return
      }
    }
    const result = input.approve ? yield* executeCall(deps, threadId, call) : DECLINED
    const answered = [...claimed.otherResponses, toolResponse(call, result)]
    const [next, ...rest] = claimed.remaining
    if (next && !deps.signal.aborted) {
      yield* holdPending(deps, threadId, {
        messageId: claimed.messageId,
        callId: next.callId,
        name: next.name,
        args: next.args,
        summary: next.summary,
        otherResponses: answered,
        remaining: rest,
      })
      return
    }
    const undone = claimed.remaining.map((c) => toolResponse({ id: c.callId, name: c.name, args: c.args }, INTERRUPTED))
    yield* persistTool(deps, threadId, [...answered, ...undone].map((r) => ({ functionResponse: r })))
  }

  if (deps.signal.aborted) return
  let contents: Content[]
  if (input.kind === 'instruction') {
    contents = toContents([input.message])
  } else {
    const history = await deps.run((db) => listMessages(db, deps.tenantId, threadId))
    if (!history.ok) {
      yield { type: 'error', message: history.error }
      return
    }
    // A message sent after Stop is not the stopped turn's to read.
    if (deps.signal.aborted) return
    const { messages } = history.value
    // Read once: a turn that fails from here on is not retried until something new arrives.
    await deps.run((db) => markRead(db, deps.tenantId, threadId, messages))
    contents = toContents(inReadingOrder(messages))
  }
  if (input.kind !== 'confirm') {
    const slot = await deps.run((db) => takeChatRateSlot(db, deps.tenantId, 'main_chat', deps.tenantId))
    if (!slot) {
      yield { type: 'error', message: `Daily chat limit reached (${MAIN_CHAT_TURNS_PER_TENANT_PER_DAY} turns) — resets at midnight UTC.` }
      return
    }
  }
  const systemInstruction = await buildContext(deps, thread.value.projectId, input.kind === 'instruction')

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let text = ''
    const calls: Array<Call & { thoughtSignature?: string }> = []
    try {
      for await (const chunk of streamGeminiChat({
        op: 'chat',
        apiKey: deps.env.GEMINI_API_KEY,
        model: HOSTED_MODEL,
        timeoutMs: 120_000,
        systemInstruction,
        contents,
        functionDeclarations: deps.tools.declarations,
        thinking: 'LOW',
        maxOutputTokens: 8192,
        signal: deps.signal,
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
    yield* persistTool(deps, threadId, settled)
    contents.push({ role: 'user', parts: settled })
    if (deps.signal.aborted) return
  }
  yield { type: 'done' }
}
