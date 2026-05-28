// Stateless transport for the OpenAI Responses API: we always pass the full
// message history rather than `previous_response_id` so the DB
// (`inquiry_messages`) stays the single source of truth for transcript state.

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

// Env subset for the LLM call path. Worker bindings carry many secrets; this
// alias names the slice every OpenAI caller needs so signatures don't bleed
// unrelated Gmail / app-url fields downward.
export type OpenAIEnv = {
  OPENAI_API_KEY: string
}

export type OpenAIRole = 'user' | 'assistant'

export type OpenAIInputMessage = {
  role: OpenAIRole
  content: string
}

export type OpenAIResponsesArgs = {
  apiKey: string
  model: string
  instructions: string
  input: OpenAIInputMessage[]
  temperature?: number
  maxOutputTokens?: number
}

export type OpenAIResponsesResult = {
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
  const body: Record<string, unknown> = {
    model: args.model,
    instructions: args.instructions,
    input: args.input.map((m) => ({ role: m.role, content: m.content })),
    // DB (`inquiry_messages`) is the single source of truth — opt out of
    // OpenAI's 30-day retention so recipient conversations aren't stored
    // upstream.
    store: false,
  }
  if (args.temperature !== undefined) body.temperature = args.temperature
  if (args.maxOutputTokens !== undefined) body.max_output_tokens = args.maxOutputTokens

  const res = await fetch(OPENAI_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    // Log the upstream body for diagnosis but never surface it to the
    // recipient (it can carry API keys, model ids, prompt fragments).
    const detail = await res.text()
    console.error('OpenAI responses non-2xx', { status: res.status, detail })
    throw new OpenAIError('upstream LLM request failed', res.status)
  }

  const data = (await res.json()) as RawResponse
  const text = extractOutputText(data)
  if (!text) {
    console.error('OpenAI responses returned no output_text', { data })
    throw new OpenAIError('upstream LLM returned empty output', 502)
  }
  return {
    outputText: text,
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
  }
}

type RawResponse = {
  output?: Array<{
    type?: string
    content?: Array<{ type?: string; text?: string }>
  }>
  output_text?: string
  usage?: { input_tokens?: number; output_tokens?: number }
}

function extractOutputText(data: RawResponse): string | null {
  // Prefer the convenience `output_text` field when present; otherwise walk the
  // structured `output[].content[]` array and concatenate every `output_text`
  // chunk. The Responses API returns the latter form on by-default settings.
  if (typeof data.output_text === 'string' && data.output_text.length > 0) {
    return data.output_text
  }
  const parts: string[] = []
  for (const item of data.output ?? []) {
    if (item.type !== 'message') continue
    for (const c of item.content ?? []) {
      if (c.type === 'output_text' && typeof c.text === 'string') {
        parts.push(c.text)
      }
    }
  }
  const joined = parts.join('').trim()
  return joined.length > 0 ? joined : null
}
