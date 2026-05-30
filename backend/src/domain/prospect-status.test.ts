import { describe, it, expect } from 'vitest'
import { nextStatusFromResponse, addMonthsUtc, addDays } from './prospect-status'

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d))

describe('nextStatusFromResponse', () => {
  it('bounce → inactive regardless of other inputs', () => {
    expect(nextStatusFromResponse({ responseType: 'bounce', sentiment: 'positive', reapproachMonths: 3 })).toBe('inactive')
  })

  it('auto_reply → null (no status change)', () => {
    expect(nextStatusFromResponse({ responseType: 'auto_reply', sentiment: 'neutral', reapproachMonths: null })).toBeNull()
  })

  it('meeting_request → responded', () => {
    expect(nextStatusFromResponse({ responseType: 'meeting_request', sentiment: 'neutral', reapproachMonths: null })).toBe('responded')
  })

  it('rejection → rejected when no reapproach window, deferred when one is set', () => {
    expect(nextStatusFromResponse({ responseType: 'rejection', sentiment: 'neutral', reapproachMonths: null })).toBe('rejected')
    expect(nextStatusFromResponse({ responseType: 'rejection', sentiment: 'neutral', reapproachMonths: 6 })).toBe('deferred')
  })

  it('negative reply behaves like rejection (deferred vs rejected on reapproach)', () => {
    expect(nextStatusFromResponse({ responseType: 'reply', sentiment: 'negative', reapproachMonths: null })).toBe('rejected')
    expect(nextStatusFromResponse({ responseType: 'reply', sentiment: 'negative', reapproachMonths: 3 })).toBe('deferred')
  })

  it('non-negative reply → responded', () => {
    expect(nextStatusFromResponse({ responseType: 'reply', sentiment: 'positive', reapproachMonths: null })).toBe('responded')
    expect(nextStatusFromResponse({ responseType: 'reply', sentiment: 'neutral', reapproachMonths: 3 })).toBe('responded')
  })
})

describe('addMonthsUtc', () => {
  it('adds within the same year', () => {
    expect(addMonthsUtc(utc(2025, 3, 15), 2).toISOString()).toBe(utc(2025, 5, 15).toISOString())
  })

  it('rolls over the year', () => {
    expect(addMonthsUtc(utc(2025, 12, 15), 1).toISOString()).toBe(utc(2026, 1, 15).toISOString())
  })

  it('clamps Jan 31 + 1mo to Feb 28 (non-leap), never spilling into March', () => {
    expect(addMonthsUtc(utc(2025, 1, 31), 1).toISOString()).toBe(utc(2025, 2, 28).toISOString())
  })

  it('clamps to Feb 29 in a leap year', () => {
    expect(addMonthsUtc(utc(2024, 1, 31), 1).toISOString()).toBe(utc(2024, 2, 29).toISOString())
  })
})

describe('addDays', () => {
  it('adds days across a month boundary', () => {
    expect(addDays(utc(2025, 1, 31), 1).toISOString()).toBe(utc(2025, 2, 1).toISOString())
  })
})
