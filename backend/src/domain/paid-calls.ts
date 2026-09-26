// A row holds what a vendor metered, never an amount: cost is computed from
// these prices, so a price change is an edit here.

export type LlmModel = 'gpt-6-luna' | 'gpt-6-sol' | 'gpt-5.4-mini'
export type PaidCallModel = LlmModel | 'emailable'

// USD per MTok, list price.
const TOKEN_PRICES: Record<LlmModel, { input: number; cachedInput: number; cacheWrite: number; output: number }> = {
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, cacheWrite: 0.9375, output: 4.5 },
}
const WEB_SEARCH_CALL_USD = 0.01
const EMAIL_VERIFY_USD = 0.0076

// input includes cachedInput and cacheWrite; output excludes thoughts.
export type PaidCallUsage = {
  input: number
  cachedInput: number
  cacheWrite: number
  output: number
  thoughts: number
  searchCalls: number
}

export type PaidCall = { op: string; model: PaidCallModel; tier: string; usage: PaidCallUsage }

export const NO_TOKENS: PaidCallUsage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, thoughts: 0, searchCalls: 0 }

export function paidCallCostUsd(call: Pick<PaidCall, 'model' | 'tier' | 'usage'>): number {
  if (call.model === 'emailable') return EMAIL_VERIFY_USD
  const p = TOKEN_PRICES[call.model]
  const u = call.usage
  const tokens =
    (u.input - u.cachedInput - u.cacheWrite) * p.input +
    u.cachedInput * p.cachedInput +
    u.cacheWrite * p.cacheWrite +
    (u.output + u.thoughts) * p.output
  return (tokens / 1e6) * (call.tier === 'flex' ? 0.5 : 1) + u.searchCalls * WEB_SEARCH_CALL_USD
}
