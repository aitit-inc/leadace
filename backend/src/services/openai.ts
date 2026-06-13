// Stateless transport for the OpenAI Responses API: we always pass the full
// message history rather than `previous_response_id` so the DB
// (`inquiry_messages`) stays the single source of truth for transcript state.

import OpenAI from 'openai'

export type OpenAIEnv = {
  OPENAI_API_KEY: string
}

export type OpenAIInputMessage = {
  role: 'user' | 'assistant'
  content: string
}

type OpenAIResponsesArgs = {
  apiKey: string
  model: string
  instructions: string
  input: OpenAIInputMessage[]
  temperature?: number
  maxOutputTokens?: number
}

type OpenAIResponsesResult = {
  outputText: string
  inputTokens: number
  outputTokens: number
}

export class OpenAIError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'OpenAIError'
    this.status = status
  }
}

export async function callOpenAIResponses(args: OpenAIResponsesArgs): Promise<OpenAIResponsesResult> {
  const client = new OpenAI({ apiKey: args.apiKey })
  let response: OpenAI.Responses.Response
  try {
    response = await client.responses.create({
      model: args.model,
      instructions: args.instructions,
      // Re-map explicitly: structural typing lets callers pass wider rows
      // (e.g. transcript entries with createdAt) that must not hit the wire.
      input: args.input.map((m) => ({ role: m.role, content: m.content })),
      // Opt out of OpenAI's 30-day retention — recipient conversations must
      // not be stored upstream.
      store: false,
      ...(args.temperature !== undefined && { temperature: args.temperature }),
      ...(args.maxOutputTokens !== undefined && { max_output_tokens: args.maxOutputTokens }),
    })
  } catch (e) {
    if (e instanceof OpenAI.APIError) {
      // Upstream detail can carry API keys / prompt fragments — log, never surface.
      console.error('OpenAI responses non-2xx', { status: e.status, detail: e.message })
      throw new OpenAIError('upstream LLM request failed', e.status ?? 502)
    }
    throw e
  }
  const text = response.output_text.trim()
  if (!text) {
    console.error('OpenAI responses returned no output_text', { id: response.id })
    throw new OpenAIError('upstream LLM returned empty output', 502)
  }
  return {
    outputText: text,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
  }
}
