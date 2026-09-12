import { describe, expect, it } from 'vitest'
import { groundingMonthKey, groundingQuotaWarning } from './grounding-usage'

describe('groundingQuotaWarning', () => {
  it('is silent below 80% of the free quota', () => {
    expect(groundingQuotaWarning(0)).toBe('')
    expect(groundingQuotaWarning(3_999)).toBe('')
  })
  it('warns from 80% up to the quota', () => {
    expect(groundingQuotaWarning(4_000)).toContain('near')
    expect(groundingQuotaWarning(4_999)).toContain('near')
  })
  it('reports the quota as used up at and beyond it', () => {
    expect(groundingQuotaWarning(5_000)).toContain('used up')
    expect(groundingQuotaWarning(12_345)).toContain('used up')
  })
})

describe('groundingMonthKey', () => {
  it('keys by UTC month, not the local one', () => {
    expect(groundingMonthKey(new Date('2026-09-30T23:30:00Z'))).toBe('2026-09')
    expect(groundingMonthKey(new Date('2026-10-01T00:00:00Z'))).toBe('2026-10')
  })
})
