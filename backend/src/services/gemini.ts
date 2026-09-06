// Official SDK straight to the Gemini API — AI Gateway doesn't cover its tools.

import {
  ApiError,
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  type Schema,
  ThinkingLevel,
} from '@google/genai'
import { z } from 'zod'

export type GeminiEnv = {
  GEMINI_API_KEY: string
}

type GeminiToolCallArgs = {
  apiKey: string
  model: string
  prompt: string
  responseSchema: Schema
  temperature: number
  maxOutputTokens: number
}

export class GeminiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GeminiError'
    this.status = status
  }
}

export type GeminiUrlContextResult = {
  text: string
  retrievedUrls: string[]
}

export async function callGeminiUrlContext(
  args: GeminiToolCallArgs,
): Promise<GeminiUrlContextResult> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  let text: string | undefined
  let retrievedUrls: string[] = []
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        tools: [{ urlContext: {} }],
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: args.responseSchema,
      },
    })
    text = response.text?.trim()
    retrievedUrls = (response.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [])
      .filter((m) => m.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
      .flatMap((m) => (m.retrievedUrl === undefined ? [] : [m.retrievedUrl]))
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  if (!text) {
    throw new GeminiError('upstream LLM returned empty output', 502)
  }
  return { text, retrievedUrls }
}

type GeminiStructuredArgs = {
  apiKey: string
  model: string
  prompt: string
  responseSchema: Schema
  temperature: number
  maxOutputTokens: number
}

export async function callGeminiStructured(args: GeminiStructuredArgs): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  let text: string | undefined
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: args.responseSchema,
      },
    })
    text = response.text?.trim()
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  if (!text) {
    throw new GeminiError('upstream LLM returned empty output', 502)
  }
  return text
}

type GeminiTextArgs = {
  apiKey: string
  model: string
  prompt: string
  temperature: number
  maxOutputTokens: number
}

export async function callGeminiText(args: GeminiTextArgs): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  let text: string | undefined
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
      },
    })
    text = response.text?.trim()
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  if (!text) {
    throw new GeminiError('upstream LLM returned empty output', 502)
  }
  return text
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

type GeminiGroundedTextArgs = {
  apiKey: string
  model: string
  prompt: string
  thinking?: HostedThinking
  maxOutputTokens: number
}

export type GeminiGroundedTextResult = {
  text: string
  // Pages the model actually read (url_context) or cited (search grounding).
  sources: string[]
}

// Search-grounded reading: Google Search for discovery plus url_context so
// the model can open what it finds. Text out — grounding tools and JSON mode
// are separate calls; the caller structures the text with callGeminiStructured.
export async function callGeminiGroundedText(args: GeminiGroundedTextArgs): Promise<GeminiGroundedTextResult> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        tools: [{ googleSearch: {} }, { urlContext: {} }],
        ...thinkingConfig(args.thinking),
        maxOutputTokens: args.maxOutputTokens,
      },
    })
    const text = response.text?.trim()
    if (!text) throw new GeminiError('upstream LLM returned empty output', 502)
    const candidate = response.candidates?.[0]
    const read = (candidate?.urlContextMetadata?.urlMetadata ?? [])
      .filter((m) => m.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
      .flatMap((m) => (m.retrievedUrl === undefined ? [] : [m.retrievedUrl]))
    const cited = (candidate?.groundingMetadata?.groundingChunks ?? [])
      .flatMap((c) => (c.web?.uri === undefined ? [] : [c.web.uri]))
    return { text, sources: [...new Set([...read, ...cited])] }
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
}

export type GeminiChatArgs = {
  apiKey: string
  model: string
  systemInstruction: string
  contents: Content[]
  functionDeclarations: FunctionDeclaration[]
  thinking?: HostedThinking
  maxOutputTokens: number
}

// One model turn of the chat agent, streamed. The caller drives the
// function-calling loop (execute calls, append responses, call again).
export async function* streamGeminiChat(args: GeminiChatArgs): AsyncGenerator<GenerateContentResponse> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
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
      },
    })
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContentStream non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  try {
    for await (const chunk of stream) yield chunk
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini stream failed', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM stream failed', e.status)
    }
    throw e
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

type GeminiJsonArgs<T> = {
  apiKey: string
  model: string
  prompt: string
  schema: z.ZodType<T>
  thinking?: HostedThinking
  maxOutputTokens: number
}

export async function callGeminiJson<T>(args: GeminiJsonArgs<T>): Promise<T> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  let text: string | undefined
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        ...thinkingConfig(args.thinking),
        maxOutputTokens: args.maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: toResponseJsonSchema(args.schema),
      },
    })
    text = response.text?.trim()
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  if (!text) throw new GeminiError('upstream LLM returned empty output', 502)
  return parseStructured(text, args.schema)
}

export type GeminiUrlJsonResult<T> = { value: T; retrievedUrls: string[] }

// Reads the URLs named in the prompt through url_context and answers in the
// schema. `retrievedUrls` is the evidence of what was actually read — callers
// treat an answer with none as invented.
export async function callGeminiUrlContextJson<T>(args: GeminiJsonArgs<T>): Promise<GeminiUrlJsonResult<T>> {
  const ai = new GoogleGenAI({ apiKey: args.apiKey })
  let text: string | undefined
  let retrievedUrls: string[] = []
  try {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: args.prompt,
      config: {
        tools: [{ urlContext: {} }],
        ...thinkingConfig(args.thinking),
        maxOutputTokens: args.maxOutputTokens,
        responseMimeType: 'application/json',
        responseJsonSchema: toResponseJsonSchema(args.schema),
      },
    })
    text = response.text?.trim()
    retrievedUrls = (response.candidates?.[0]?.urlContextMetadata?.urlMetadata ?? [])
      .filter((m) => m.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')
      .flatMap((m) => (m.retrievedUrl === undefined ? [] : [m.retrievedUrl]))
  } catch (e) {
    if (e instanceof ApiError) {
      console.error('Gemini generateContent non-2xx', { status: e.status, detail: e.message })
      throw new GeminiError('upstream LLM request failed', e.status)
    }
    throw e
  }
  if (!text) throw new GeminiError('upstream LLM returned empty output', 502)
  return { value: parseStructured(text, args.schema), retrievedUrls }
}
