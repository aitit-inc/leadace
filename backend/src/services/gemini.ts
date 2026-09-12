// Official SDK straight to the Gemini API — AI Gateway doesn't cover its tools.

import { AsyncLocalStorage } from 'node:async_hooks'
import {
  ApiError,
  GoogleGenAI,
  type Content,
  type ContentListUnion,
  type FunctionDeclaration,
  type GenerateContentConfig,
  type GenerateContentResponse,
  type Schema,
  ServiceTier,
  ThinkingLevel,
} from '@google/genai'
import { z } from 'zod'

export type GeminiEnv = {
  GEMINI_API_KEY: string
}

type GeminiCall = {
  op: string
  apiKey: string
  model: string
  // A call with no deadline burns its Workflow step's whole budget — a
  // url_context read once stalled for seven minutes. Sized per op.
  timeoutMs: number
  // Unattended stage calls take the flex tier: half price, best-effort capacity.
  tier?: 'flex'
}

// Who a call is for, carried on the [llm] usage line so spend can be cut per
// tenant, job or chat thread instead of per time window.
export type LlmScope = { tenantId: string; jobId?: string; threadId?: string }
const llmScope = new AsyncLocalStorage<LlmScope>()

export function withLlmScope<T>(scope: LlmScope, fn: () => Promise<T>): Promise<T> {
  return llmScope.run(scope, fn)
}

export class GeminiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
  }
}

// Billing: input = input + toolInput (cachedInput is the discounted part),
// output = output + thoughts, search queries priced per query.
function logUsage(call: GeminiCall, response: GenerateContentResponse, tier: ServiceTier | undefined): void {
  const u = response.usageMetadata
  console.log({
    message: `[llm] ${call.op}`,
    ...llmScope.getStore(),
    op: call.op,
    model: call.model,
    input: u?.promptTokenCount ?? 0,
    cachedInput: u?.cachedContentTokenCount ?? 0,
    toolInput: u?.toolUsePromptTokenCount ?? 0,
    output: u?.candidatesTokenCount ?? 0,
    thoughts: u?.thoughtsTokenCount ?? 0,
    tier: tier ?? ServiceTier.STANDARD,
    searchQueries: searchQueriesOf(response),
  })
}

// Google bills the unique non-empty queries of a request.
function searchQueriesOf(response: GenerateContentResponse): number {
  return new Set((response.candidates?.[0]?.groundingMetadata?.webSearchQueries ?? []).filter((q) => q !== '')).size
}

const FLEX_SHED_STATUSES = [429, 503]

function toGeminiError(e: unknown, call: GeminiCall, phase: 'request' | 'stream', deadline: AbortSignal, tier?: ServiceTier): never {
  if (deadline.aborted) {
    console.error(`Gemini ${phase} timed out`, { op: call.op, timeoutMs: call.timeoutMs })
    throw new GeminiError(`upstream LLM ${phase} timed out after ${call.timeoutMs}ms`, 504)
  }
  if (e instanceof ApiError) {
    if (tier === ServiceTier.FLEX && FLEX_SHED_STATUSES.includes(e.status)) console.warn('Gemini flex shed', { op: call.op, status: e.status })
    else console.error(`Gemini ${phase} non-2xx`, { op: call.op, status: e.status, detail: e.message })
    throw new GeminiError(`upstream LLM ${phase} failed`, e.status)
  }
  throw e
}

async function attempt(
  call: GeminiCall,
  contents: ContentListUnion,
  config: GenerateContentConfig,
  deadline: AbortSignal,
): Promise<GenerateContentResponse> {
  const ai = new GoogleGenAI({ apiKey: call.apiKey })
  let response: GenerateContentResponse
  try {
    response = await ai.models.generateContent({ model: call.model, contents, config: { ...config, abortSignal: deadline } })
  } catch (e) {
    toGeminiError(e, call, 'request', deadline, config.serviceTier)
  }
  logUsage(call, response, config.serviceTier)
  return response
}

const FLEX_RETRY_DELAY_MS = [1_000, 4_000]

// Flex sheds a request with 429 / 503 within seconds (7 of 13 at one measured
// peak, all accepted on the next try) and never upgrades it itself. Shed:
// retry; still shed: the standard tier, so a stage never loses work to the
// discount. One deadline spans every attempt: the call's timeoutMs stays the
// bound a step can plan on, so a flex request queued that long fails as any
// slow call would.
async function generate(
  call: GeminiCall,
  contents: ContentListUnion,
  config: GenerateContentConfig,
): Promise<GenerateContentResponse> {
  const deadline = AbortSignal.timeout(call.timeoutMs)
  if (call.tier !== 'flex') return attempt(call, contents, config, deadline)
  const flex = { ...config, serviceTier: ServiceTier.FLEX }
  for (let retry = 0; ; retry++) {
    try {
      return await attempt(call, contents, flex, deadline)
    } catch (e) {
      if (!(e instanceof GeminiError) || !FLEX_SHED_STATUSES.includes(e.status)) throw e
      const delay = FLEX_RETRY_DELAY_MS[retry]
      if (delay === undefined) return attempt(call, contents, config, deadline)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

function textOf(response: GenerateContentResponse): string {
  const text = response.text?.trim()
  if (!text) throw new GeminiError('upstream LLM returned empty output', 502)
  return text
}

function retrievedUrlsOf(response: GenerateContentResponse): string[] {
  return (response.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [])
    .filter((m) => m.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
    .flatMap((m) => (m.retrievedUrl === undefined ? [] : [m.retrievedUrl]))
}

type GeminiSchemaArgs = GeminiCall & {
  prompt: string
  responseSchema: Schema
  temperature: number
  maxOutputTokens: number
}

export type GeminiUrlContextResult = {
  text: string
  retrievedUrls: string[]
}

export async function callGeminiUrlContext(
  args: GeminiSchemaArgs,
): Promise<GeminiUrlContextResult> {
  const response = await generate(args, args.prompt, {
    tools: [{ urlContext: {} }],
    temperature: args.temperature,
    maxOutputTokens: args.maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: args.responseSchema,
  })
  return { text: textOf(response), retrievedUrls: retrievedUrlsOf(response) }
}

export async function callGeminiStructured(args: GeminiSchemaArgs): Promise<string> {
  const response = await generate(args, args.prompt, {
    temperature: args.temperature,
    maxOutputTokens: args.maxOutputTokens,
    responseMimeType: 'application/json',
    responseSchema: args.responseSchema,
  })
  return textOf(response)
}

type GeminiTextArgs = GeminiCall & {
  prompt: string
  temperature: number
  maxOutputTokens: number
}

export async function callGeminiText(args: GeminiTextArgs): Promise<string> {
  const response = await generate(args, args.prompt, {
    temperature: args.temperature,
    maxOutputTokens: args.maxOutputTokens,
  })
  return textOf(response)
}

// Every hosted-agent stage and the chat agent run on one model; cost tuning
// per stage is a later measurement, not a design axis. Gemini 3.8 takes no
// sampling parameters (temperature / top_p / top_k are rejected by its
// migration checklist); depth is steered with the thinking level.
export const HOSTED_MODEL = 'gemini-3.8-flash'
export type HostedThinking = 'LOW' | 'MEDIUM'
function thinkingConfig(level: HostedThinking | undefined) {
  return level ? { thinkingConfig: { thinkingLevel: level === 'LOW' ? ThinkingLevel.LOW : ThinkingLevel.MEDIUM } } : {}
}

type GeminiGroundedTextArgs = GeminiCall & {
  prompt: string
  thinking?: HostedThinking
  maxOutputTokens: number
}

export type Citation = { passage: string; pages: string[] }
export type GroundedText = { text: string; citations: Citation[]; searchQueries: number }

// Search-grounded reading: Google Search for discovery plus url_context so
// the model can open what it finds. Text out — grounding tools and JSON mode
// are separate calls; the caller structures the text with callGeminiStructured.
// Citations are the search's own record; a page the model names in its text
// may not exist.
export async function callGeminiGroundedText(args: GeminiGroundedTextArgs): Promise<GroundedText> {
  const response = await generate(args, args.prompt, {
    tools: [{ googleSearch: {} }, { urlContext: {} }],
    ...thinkingConfig(args.thinking),
    maxOutputTokens: args.maxOutputTokens,
  })
  const grounding = response.candidates?.[0]?.groundingMetadata
  const links = (grounding?.groundingChunks ?? []).map((c) => c.web?.uri)
  const pages: Array<string | null> = []
  // Workers queues requests beyond six in flight with their timeouts running;
  // three leaves room for the other passes' requests.
  for (let i = 0; i < links.length; i += 3) pages.push(...(await Promise.all(links.slice(i, i + 3).map(pageOf))))
  const supports = (grounding?.groundingSupports ?? []).map((s) => ({ passage: s.segment?.text ?? '', chunks: s.groundingChunkIndices ?? [] }))
  return { text: textOf(response), citations: citationsOf(supports, pages), searchQueries: searchQueriesOf(response) }
}

// Grounding cites each result by a Google redirect link; its Location is the page.
async function pageOf(uri: string | undefined): Promise<string | null> {
  if (!uri?.startsWith('https://vertexaisearch.cloud.google.com/grounding-api-redirect/')) return null
  try {
    const res = await fetch(uri, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    await res.body?.cancel()
    return res.headers.get('location')
  } catch {
    return null
  }
}

export function citationsOf(supports: Array<{ passage: string; chunks: number[] }>, pages: Array<string | null>): Citation[] {
  const byPassage = new Map<string, Set<string>>()
  for (const { passage, chunks } of supports) {
    const found = chunks.flatMap((i) => pages[i] ?? [])
    if (passage === '' || found.length === 0) continue
    byPassage.set(passage, new Set([...(byPassage.get(passage) ?? []), ...found]))
  }
  return [...byPassage].map(([passage, set]) => ({ passage, pages: [...set] }))
}

export type GeminiChatArgs = GeminiCall & {
  systemInstruction: string
  contents: Content[]
  functionDeclarations: FunctionDeclaration[]
  thinking?: HostedThinking
  maxOutputTokens: number
  // Stopping is not a failure: the stream ends where the answer stands.
  signal: AbortSignal
}

// One model turn of the chat agent, streamed. The caller drives the
// function-calling loop (execute calls, append responses, call again).
// Usage arrives on the chunks; the last one carrying it holds the totals.
export async function* streamGeminiChat(args: GeminiChatArgs): AsyncGenerator<GenerateContentResponse> {
  // The SDK ignores a signal that is already aborted.
  if (args.signal.aborted) return
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  const deadline = AbortSignal.timeout(args.timeoutMs)
  let stream: AsyncGenerator<GenerateContentResponse>
  try {
    stream = await ai.models.generateContentStream({
      model: args.model,
      contents: args.contents,
      config: {
        systemInstruction: args.systemInstruction,
        tools: [{ functionDeclarations: args.functionDeclarations }],
        ...thinkingConfig(args.thinking),
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: AbortSignal.any([deadline, args.signal]),
      },
    })
  } catch (e) {
    if (args.signal.aborted) return
    toGeminiError(e, args, 'request', deadline)
  }
  let last: GenerateContentResponse | undefined
  try {
    for await (const chunk of stream) {
      if (args.signal.aborted) return
      if (chunk.usageMetadata) last = chunk
      yield chunk
    }
  } catch (e) {
    if (args.signal.aborted) return
    toGeminiError(e, args, 'stream', deadline)
  } finally {
    if (last) logUsage(args, last, undefined)
  }
}

// --- Schema-typed calls. The zod schema is the single definition: it becomes
// the model's response constraint (responseJsonSchema) and validates the reply.

function toResponseJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7', io: 'output' }) as Record<string, unknown>
  delete json['$schema']
  return json
}

function parseStructured<T>(text: string, schema: z.ZodType<T>): T {
  let candidate: unknown
  try {
    candidate = JSON.parse(text)
  } catch {
    console.error('Gemini structured output was not JSON', { head: text.slice(0, 300), length: text.length })
    throw new GeminiError('upstream LLM returned non-JSON output', 502)
  }
  const parsed = schema.safeParse(candidate)
  if (!parsed.success) {
    console.error('Gemini structured output failed validation', z.flattenError(parsed.error))
    throw new GeminiError('upstream LLM output did not match the schema', 502)
  }
  return parsed.data
}

type GeminiJsonArgs<T> = GeminiCall & {
  prompt: string
  schema: z.ZodType<T>
  thinking?: HostedThinking
  maxOutputTokens: number
}

export async function callGeminiJson<T>(args: GeminiJsonArgs<T>): Promise<T> {
  const response = await generate(args, args.prompt, {
    ...thinkingConfig(args.thinking),
    maxOutputTokens: args.maxOutputTokens,
    responseMimeType: 'application/json',
    responseJsonSchema: toResponseJsonSchema(args.schema),
  })
  return parseStructured(textOf(response), args.schema)
}

export type GeminiUrlJsonResult<T> = { value: T; retrievedUrls: string[] }

// Reads the URLs named in the prompt through url_context and answers in the
// schema. `retrievedUrls` is the evidence of what was actually read — callers
// treat an answer with none as invented.
export async function callGeminiUrlContextJson<T>(args: GeminiJsonArgs<T>): Promise<GeminiUrlJsonResult<T>> {
  const response = await generate(args, args.prompt, {
    tools: [{ urlContext: {} }],
    ...thinkingConfig(args.thinking),
    maxOutputTokens: args.maxOutputTokens,
    responseMimeType: 'application/json',
    responseJsonSchema: toResponseJsonSchema(args.schema),
  })
  return { value: parseStructured(textOf(response), args.schema), retrievedUrls: retrievedUrlsOf(response) }
}
