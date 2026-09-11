import { describe, expect, it } from 'vitest'
import { isRecentSignal } from './jobs'

describe('isRecentSignal', () => {
  const now = new Date('2026-09-11T15:00:00Z')

  it('keeps an event dated up to 90 calendar days ago, whatever the hour', () => {
    expect(isRecentSignal('2026-07-14: Partnered with the Musashino University EMC', now)).toBe(true)
    expect(isRecentSignal('2026-06-13: Raised a Series A', now)).toBe(true)
    expect(isRecentSignal('2026-09-11: Opened a new campus', now)).toBe(true)
  })

  it('drops an event older than 90 days', () => {
    expect(isRecentSignal('2026-06-12: Raised a Series A', now)).toBe(false)
  })

  it('drops an event dated after today or not dated at the start', () => {
    expect(isRecentSignal('2026-09-12: Opens a new campus', now)).toBe(false)
    expect(isRecentSignal('Raised a Series A on 2026-08-01', now)).toBe(false)
    expect(isRecentSignal('2026-13-40: Garbled date', now)).toBe(false)
  })

  it('drops an impossible calendar date instead of rolling it over', () => {
    const may = new Date('2026-05-01T15:00:00Z')
    expect(isRecentSignal('2026-02-30: Impossible date', may)).toBe(false)
    expect(isRecentSignal('2026-04-31: Impossible date', may)).toBe(false)
    expect(isRecentSignal('2026-04-30: Real date', may)).toBe(true)
  })
})
