// Official SDK straight to the Gemini API — AI Gateway doesn't cover its tools.

import { ApiError, GoogleGenAI, type Schema } from '@google/genai'

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
