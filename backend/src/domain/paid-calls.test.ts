import { describe, expect, it } from 'vitest'
import { NO_TOKENS, paidCallCostUsd } from './paid-calls'

describe('paidCallCostUsd', () => {
  it('prices uncached input, cache reads, cache writes and output with its reasoning apart', () => {
    const usage = { input: 1_000_000, cachedInput: 200_000, cacheWrite: 100_000, output: 300_000, thoughts: 200_000, searchCalls: 0 }
    // 0.7M × 0.10 + 0.2M × 0.01 + 0.1M × 0.125 + 0.5M × 0.50
    expect(paidCallCostUsd({ model: 'gpt-6-luna', tier: 'default', usage })).toBeCloseTo(0.3345, 10)
  })

  it('halves tokens on flex but not search calls', () => {
    const usage = { ...NO_TOKENS, input: 1_000_000, searchCalls: 3 }
    expect(paidCallCostUsd({ model: 'gpt-6-sol', tier: 'flex', usage })).toBeCloseTo(1 + 0.03, 10)
  })

  it('prices a verification per call', () => {
    expect(paidCallCostUsd({ model: 'emailable', tier: 'default', usage: NO_TOKENS })).toBe(0.0076)
  })
})
