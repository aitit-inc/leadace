import type { LlmModel, PaidCallUsage } from '../../domain/paid-calls'
import { currentPaidCallScope, recordPaidCall } from '../paid-calls'

export type LlmEnv = {
  OPENAI_API_KEY: string
}

export class LlmError extends Error {
  status: number
  // The provider could not serve the request (shed, server error, timed out,
  // unreachable): another tier may. Any other failure recurs on every tier.
  unavailable: boolean
  constructor(message: string, status: number, unavailable = false) {
    super(message)
    this.name = 'LlmError'
    this.status = status
    this.unavailable = unavailable
  }
}

export type Citation = { passage: string; pages: string[] }
// responseId: the stored response a follow-up call continues from.
export type GroundedText = { text: string; citations: Citation[]; responseId: string }
export type UrlJsonResult<T> = { value: T; retrievedUrls: string[] }

// searchQueries is the unique queries the search calls ran, for reading only.
export type LlmUsage = PaidCallUsage & {
  toolInput: number
  searchQueries: number
}

export async function recordUsage(call: { op: string; model: LlmModel; tier: string; elapsedMs: number }, usage: LlmUsage): Promise<void> {
  console.log({ message: `[llm] ${call.op}`, ...currentPaidCallScope(), op: call.op, model: call.model, tier: call.tier, elapsedMs: call.elapsedMs, ...usage })
  await recordPaidCall({ op: call.op, model: call.model, tier: call.tier, usage })
}
