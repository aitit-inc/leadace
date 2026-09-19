import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import type { FunctionTool, Response, ResponseCreateParamsNonStreaming, ResponseInputItem, ResponseOutputText } from 'openai/resources/responses/responses'
import { z } from 'zod'
import { LlmError, logUsage, type Citation, type GroundedText } from './common'

export type OpenAIRoute = {
  model: string
  timeoutMs: number
  // A flex attempt shed or past this deadline gets one standard attempt with
  // timeoutMs, so the half price costs at most this much waiting. null: standard only.
  flexTimeoutMs: number | null
  // Reasoning tokens come out of this cap too.
  maxOutputTokens: number
}

export type OpenAICall = OpenAIRoute & {
  op: string
  apiKey: string
}

type Tier = 'flex' | 'default'

const FLEX_SHED_STATUS = 429

// The route's deadlines bound each call and the Workflow step owns retries;
// the SDK's own retries would multiply the deadline a step plans on.
function clientOf(call: OpenAICall): OpenAI {
  return new OpenAI({ apiKey: call.apiKey, maxRetries: 0 })
}

function toLlmError(e: unknown, call: OpenAICall, tier: Tier, timeoutMs: number, deadline: AbortSignal): LlmError {
  if (deadline.aborted || e instanceof OpenAI.APIConnectionTimeoutError) {
    console.error('OpenAI request timed out', { op: call.op, tier, timeoutMs })
    return new LlmError(`upstream LLM request timed out after ${timeoutMs}ms`, 504)
  }
  // An error event inside a stream arrives as an APIError with no status.
  if (e instanceof OpenAI.APIError) {
    if (tier === 'flex' && e.status === FLEX_SHED_STATUS) console.warn('OpenAI flex shed', { op: call.op })
    // Upstream detail can carry prompt fragments — log, never surface.
    else console.error('OpenAI request non-2xx', { op: call.op, tier, status: e.status, detail: e.message })
    return new LlmError('upstream LLM request failed', e.status ?? 502)
  }
  if (e instanceof OpenAI.APIConnectionError) {
    console.error('OpenAI request failed', { op: call.op, tier, detail: e.message })
    return new LlmError('upstream LLM request failed', 502)
  }
  // With an API key the SDK rethrows a failed body read as it came from fetch.
  if (e instanceof TypeError) {
    console.error('OpenAI response body failed', { op: call.op, tier, detail: e.message })
    return new LlmError('upstream LLM request failed', 502)
  }
  // responses.parse runs JSON.parse and the zod schema on the answer.
  if (e instanceof SyntaxError || e instanceof z.ZodError) {
    console.error('OpenAI structured output did not parse', { op: call.op, detail: e.message.slice(0, 300) })
    return new LlmError('upstream LLM output did not match the schema', 502)
  }
  throw e
}

type Send<R> = (tier: Tier, deadline: AbortSignal) => Promise<R>

// The deadline is a signal rather than the SDK's `timeout`, which stops
// covering the call once headers arrive — an error body can stall past it.
async function attempt<R extends Response>(call: OpenAICall, tier: Tier, timeoutMs: number, send: Send<R>): Promise<R> {
  const deadline = AbortSignal.timeout(timeoutMs)
  let response: R
  try {
    response = await send(tier, deadline)
  } catch (e) {
    throw toLlmError(e, call, tier, timeoutMs, deadline)
  }
  logOpenAIUsage(call, response, tier)
  if (response.status !== 'completed') {
    console.error('OpenAI response incomplete', { op: call.op, status: response.status, reason: response.incomplete_details?.reason })
    throw new LlmError(`upstream LLM response ${response.status ?? 'without status'}`, 502)
  }
  return response
}

async function withTier<R extends Response>(call: OpenAICall, send: Send<R>): Promise<R> {
  if (call.flexTimeoutMs === null) return attempt(call, 'default', call.timeoutMs, send)
  try {
    return await attempt(call, 'flex', call.flexTimeoutMs, send)
  } catch (e) {
    if (!(e instanceof LlmError) || (e.status !== FLEX_SHED_STATUS && e.status !== 504)) throw e
    return attempt(call, 'default', call.timeoutMs, send)
  }
}

function logOpenAIUsage(call: OpenAICall, response: Response, tier: Tier): void {
  const u = response.usage
  // Each web_search_call item bills as one call, whatever its action (matched
  // the Usage dashboard when measured).
  const searches = response.output.flatMap((o) => (o.type === 'web_search_call' ? [o] : []))
  const queries = searches.flatMap((o) => (o.action?.type === 'search' ? (o.action.queries ?? (o.action.query === undefined ? [] : [o.action.query])) : []))
  const reasoning = u?.output_tokens_details.reasoning_tokens ?? 0
  logUsage(
    { op: call.op, model: call.model, tier: response.service_tier ?? tier },
    {
      input: u?.input_tokens ?? 0,
      cachedInput: u?.input_tokens_details.cached_tokens ?? 0,
      toolInput: 0,
      // output_tokens includes the reasoning; the log keeps them apart.
      output: (u?.output_tokens ?? 0) - reasoning,
      thoughts: reasoning,
      searchQueries: new Set(queries).size,
      searchCalls: searches.length,
    },
  )
}

type TextPart = Pick<ResponseOutputText, 'text' | 'annotations'>

function textPartsOf(response: Response): TextPart[] {
  return response.output.flatMap((o) => (o.type === 'message' ? o.content.flatMap((c) => (c.type === 'output_text' ? [c] : [])) : []))
}

// Search results carry this tag; left on, one page reads as two.
export function withoutOpenAITag(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.searchParams.get('utm_source') !== 'openai') return url
  parsed.searchParams.delete('utm_source')
  return parsed.toString()
}

// A `url_citation` span is the citation marker in the text, not the sentence
// it supports (unlike Gemini's grounding supports), so a passage names a page
// rather than stating a claim. Offsets are part-local: each slice comes from
// its own part's text.
export function citationsOf(parts: TextPart[]): Citation[] {
  const byPassage = new Map<string, Set<string>>()
  for (const part of parts) {
    for (const a of part.annotations) {
      if (a.type !== 'url_citation') continue
      const passage = part.text.slice(a.start_index, a.end_index).trim()
      if (passage === '') continue
      byPassage.set(passage, new Set([...(byPassage.get(passage) ?? []), withoutOpenAITag(a.url)]))
    }
  }
  return [...byPassage].map(([passage, pages]) => ({ passage, pages: [...pages] }))
}

// Stored upstream (30 days) so a follow-up call can continue from the search,
// its tool calls included, instead of re-sending them.
export async function callOpenAIGroundedText(args: OpenAICall & { prompt: string }): Promise<GroundedText> {
  const client = clientOf(args)
  const response = await withTier(args, (tier, signal) =>
    client.responses.create(
      {
        model: args.model,
        input: args.prompt,
        tools: [{ type: 'web_search' }],
        store: true,
        service_tier: tier,
        max_output_tokens: args.maxOutputTokens,
      },
      { signal },
    ),
  )
  const text = response.output_text.trim()
  if (text === '') throw new LlmError('upstream LLM returned empty output', 502)
  return { text, citations: citationsOf(textPartsOf(response)), responseId: response.id }
}

type OpenAIJsonArgs<T> = OpenAICall & { prompt: string; schema: z.ZodType<T> }
type JsonRequestExtras = Pick<ResponseCreateParamsNonStreaming, 'previous_response_id' | 'tools'>

async function parseOpenAIJson<T>(args: OpenAIJsonArgs<T>, extras: JsonRequestExtras): Promise<{ value: T; response: Response }> {
  const client = clientOf(args)
  const format = zodTextFormat(args.schema, args.op.replace(/[^a-zA-Z0-9_-]/g, '_'))
  const response = await withTier(args, (tier, signal) =>
    client.responses.parse(
      {
        model: args.model,
        input: args.prompt,
        ...extras,
        store: false,
        text: { format },
        service_tier: tier,
        max_output_tokens: args.maxOutputTokens,
      },
      { signal },
    ),
  )
  // null when the model refused instead of answering.
  if (response.output_parsed === null) {
    console.error('OpenAI structured output missing', { op: args.op, id: response.id })
    throw new LlmError('upstream LLM returned no structured output', 502)
  }
  return { value: response.output_parsed, response }
}

export async function callOpenAIJson<T>(args: OpenAIJsonArgs<T>): Promise<T> {
  return (await parseOpenAIJson(args, {})).value
}

export async function callOpenAIFollowUpJson<T>(args: OpenAIJsonArgs<T> & { after: GroundedText }): Promise<T> {
  return (await parseOpenAIJson(args, { previous_response_id: args.after.responseId })).value
}

// A search result the model was only shown, never opened or cited, is not a
// page it read.
export function searchedPagesOf(response: Response, domains: string[]): string[] {
  const urls = response.output.flatMap((o) => {
    if (o.type === 'web_search_call') {
      if (o.status !== 'completed') return []
      if (o.action?.type === 'open_page') return o.action.url ? [o.action.url] : []
      return []
    }
    if (o.type === 'message') return o.content.flatMap((c) => (c.type === 'output_text' ? c.annotations.flatMap((a) => (a.type === 'url_citation' ? [a.url] : [])) : []))
    return []
  })
  const onDomain = (u: string) => {
    try {
      const host = new URL(u).hostname
      return domains.some((d) => host === d || host.endsWith(`.${d}`))
    } catch {
      return false
    }
  }
  return [...new Set(urls.map(withoutOpenAITag).filter(onDomain))]
}

export async function callOpenAISearchJson<T>(args: OpenAIJsonArgs<T> & { domains: string[] }): Promise<{ value: T; searchedUrls: string[] }> {
  const { value, response } = await parseOpenAIJson(args, {
    tools: [{ type: 'web_search', filters: { allowed_domains: args.domains } }],
  })
  return { value, searchedUrls: searchedPagesOf(response, args.domains) }
}

export type ChatCall = { id: string; name: string; args: Record<string, unknown> }

// A chat response's text as it arrives, then — unless stopped or cut off — the stored
// response a next call continues from and the calls it asks for.
export type ChatStreamEvent = { type: 'text'; text: string } | { type: 'completed'; responseId: string; calls: ChatCall[] }

export type ChatRequest = {
  instructions: string
  input: ResponseInputItem[]
  // The stored response the input continues; null sends the whole context.
  previousResponseId: string | null
  tools: FunctionTool[]
  // Stopping is not a failure: the stream ends where the answer stands.
  signal: AbortSignal
}

function callsOf(call: OpenAICall, response: Response): ChatCall[] {
  return response.output.flatMap((o) => {
    if (o.type !== 'function_call') return []
    try {
      return [{ id: o.call_id, name: o.name, args: JSON.parse(o.arguments) as Record<string, unknown> }]
    } catch {
      console.error('OpenAI tool call arguments did not parse', { op: call.op, name: o.name, head: o.arguments.slice(0, 300) })
      throw new LlmError('upstream LLM returned a malformed tool call', 502)
    }
  })
}

// Stored (30 days) so the next call, within the turn or the next one, sends
// only what came after it.
export async function* streamOpenAIChat(args: OpenAICall & ChatRequest): AsyncGenerator<ChatStreamEvent> {
  if (args.signal.aborted) return
  const client = clientOf(args)
  const deadline = AbortSignal.timeout(args.timeoutMs)
  try {
    const stream = await client.responses.create(
      {
        model: args.model,
        instructions: args.instructions,
        input: args.input,
        previous_response_id: args.previousResponseId,
        tools: args.tools,
        store: true,
        stream: true,
        // A long thread drops its oldest items rather than failing.
        truncation: 'auto',
        // A person waits on every answer.
        reasoning: { effort: 'low' },
        max_output_tokens: args.maxOutputTokens,
      },
      { signal: AbortSignal.any([deadline, args.signal]) },
    )
    for await (const event of stream) {
      switch (event.type) {
        case 'response.output_text.delta':
          yield { type: 'text', text: event.delta }
          break
        case 'response.completed':
          logOpenAIUsage(args, event.response, 'default')
          yield { type: 'completed', responseId: event.response.id, calls: callsOf(args, event.response) }
          return
        // Cut off (the output cap): the person has read the text, so it stands
        // like a stopped answer; the response is not continued.
        case 'response.incomplete':
          logOpenAIUsage(args, event.response, 'default')
          console.warn('OpenAI response incomplete', { op: args.op, reason: event.response.incomplete_details?.reason })
          return
        case 'response.failed':
          logOpenAIUsage(args, event.response, 'default')
          console.error('OpenAI response failed', { op: args.op, code: event.response.error?.code, detail: event.response.error?.message })
          throw new LlmError('upstream LLM response failed', 502)
      }
    }
    if (!args.signal.aborted) {
      console.error('OpenAI stream ended without a final event', { op: args.op })
      throw new LlmError('upstream LLM stream ended early', 502)
    }
  } catch (e) {
    if (args.signal.aborted) return
    if (e instanceof LlmError) throw e
    throw toLlmError(e, args, 'default', args.timeoutMs, deadline)
  }
}
