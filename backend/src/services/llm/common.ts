import { AsyncLocalStorage } from 'node:async_hooks'

export type LlmEnv = {
  OPENAI_API_KEY: string
}

// Who a call is for, carried on the [llm] usage line so spend can be cut per
// tenant, job or chat thread instead of per time window.
export type LlmScope = { tenantId: string; jobId?: string; threadId?: string }
const llmScope = new AsyncLocalStorage<LlmScope>()

export function withLlmScope<T>(scope: LlmScope, fn: () => Promise<T>): Promise<T> {
  return llmScope.run(scope, fn)
}

export class LlmError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'LlmError'
    this.status = status
  }
}

export type Citation = { passage: string; pages: string[] }
// responseId: the stored response a follow-up call continues from.
export type GroundedText = { text: string; citations: Citation[]; responseId: string }
export type UrlJsonResult<T> = { value: T; retrievedUrls: string[] }

// cachedInput and cacheWrite are parts of input, billed at a tenth of the
// input price and at 1.25x. Output bills as output + thoughts. Search bills
// per search call (searchCalls); searchQueries is the unique queries those
// calls ran, for reading only.
export type LlmUsage = {
  input: number
  cachedInput: number
  cacheWrite: number
  toolInput: number
  output: number
  thoughts: number
  searchQueries: number
  searchCalls: number
}

export function logUsage(call: { op: string; model: string; tier: string; elapsedMs: number }, usage: LlmUsage): void {
  console.log({ message: `[llm] ${call.op}`, ...llmScope.getStore(), op: call.op, model: call.model, tier: call.tier, elapsedMs: call.elapsedMs, ...usage })
}
