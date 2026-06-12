// REST direct — AI Gateway doesn't cover grounding.

const GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

export type GeminiEnv = {
  GEMINI_API_KEY: string
}

export type GeminiGroundedArgs = {
  apiKey: string
  model: string
  prompt: string
  responseSchema: Record<string, unknown>
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

export async function callGeminiGrounded(args: GeminiGroundedArgs): Promise<string> {
  const body = {
    contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: args.temperature,
      maxOutputTokens: args.maxOutputTokens,
      responseMimeType: 'application/json',
      responseSchema: args.responseSchema,
    },
  }

  // Key in a header, not the `?key=` query param — request URLs end up in logs.
  const res = await fetch(`${GEMINI_API_BASE_URL}/models/${args.model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': args.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const detail = await res.text()
    console.error('Gemini generateContent non-2xx', { status: res.status, detail })
    throw new GeminiError('upstream LLM request failed', res.status)
  }

  const data = (await res.json()) as RawGeminiResponse
  const text = extractCandidateText(data)
  if (!text) {
    throw new GeminiError('upstream LLM returned empty output', 502)
  }
  return text
}

export type RawGeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> }
    groundingMetadata?: unknown
  }>
}

// Model output lives in `parts[].text` only, possibly split across parts;
// grounding metadata sits alongside.
export function extractCandidateText(data: RawGeminiResponse): string | null {
  const parts = data.candidates?.[0]?.content?.parts ?? []
  const joined = parts
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  return joined.length > 0 ? joined : null
}
