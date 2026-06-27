import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WARMUP,
  mailboxDailyCap,
  mailboxDailyStatus,
  warmupWeeksElapsed,
  type MailboxWarmupState,
} from './warmup'

// Fixed anchor; warmupStartedAt offsets are derived from it so the math is
// independent of wall-clock (domain functions take `now` explicitly).
const NOW = new Date('2026-06-21T12:00:00Z')
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000)

const base: MailboxWarmupState = {
  warmupStartedAt: null,
  warmupEnabled: true,
  dailyCapOverride: null,
  pausedUntil: null,
}

describe('mailboxDailyCap', () => {
  it('never-sent mailbox sits at the day-1 start cap', () => {
    expect(mailboxDailyCap(base, DEFAULT_WARMUP, NOW)).toBe(10)
  })

  it('applies the override ceiling to a never-sent mailbox (week 0 of ramp)', () => {
    expect(mailboxDailyCap({ ...base, dailyCapOverride: 3 }, DEFAULT_WARMUP, NOW)).toBe(3) // min(10, 3)
    expect(mailboxDailyCap({ ...base, dailyCapOverride: 50 }, DEFAULT_WARMUP, NOW)).toBe(10) // min(10, 50)
  })

  it('treats dailyCapOverride=0 as a hard block, not "no override"', () => {
    expect(
      mailboxDailyCap({ ...base, warmupEnabled: false, dailyCapOverride: 0 }, DEFAULT_WARMUP, NOW),
    ).toBe(0)
    expect(
      mailboxDailyCap({ ...base, warmupStartedAt: weeksAgo(3), dailyCapOverride: 0 }, DEFAULT_WARMUP, NOW),
    ).toBe(0)
  })

  it('ramps linearly (floored) from start to steady over rampWeeks', () => {
    const at = (n: number) =>
      mailboxDailyCap({ ...base, warmupStartedAt: weeksAgo(n) }, DEFAULT_WARMUP, NOW)
    expect(at(0)).toBe(10)
    expect(at(1)).toBe(13)
    expect(at(2)).toBe(17)
    expect(at(3)).toBe(21)
    expect(at(4)).toBe(25) // ramp complete → steady
    expect(at(10)).toBe(25) // stays at steady
  })

  it('disabled warmup goes straight to steady (or the override)', () => {
    expect(mailboxDailyCap({ ...base, warmupEnabled: false }, DEFAULT_WARMUP, NOW)).toBe(25)
    expect(
      mailboxDailyCap(
        { ...base, warmupEnabled: false, dailyCapOverride: 200 },
        DEFAULT_WARMUP,
        NOW,
      ),
    ).toBe(200)
  })

  it('override is a ceiling during ramp (cannot raise above the ramp step)', () => {
    const state = { ...base, warmupStartedAt: weeksAgo(3), dailyCapOverride: 12 }
    expect(mailboxDailyCap(state, DEFAULT_WARMUP, NOW)).toBe(12) // min(21, 12)
    const high = { ...base, warmupStartedAt: weeksAgo(3), dailyCapOverride: 50 }
    expect(mailboxDailyCap(high, DEFAULT_WARMUP, NOW)).toBe(21) // min(21, 50)
  })

  it('paused mailbox is hard-stopped at 0 until pausedUntil passes', () => {
    const paused = { ...base, warmupStartedAt: weeksAgo(10), pausedUntil: new Date(NOW.getTime() + 1000) }
    expect(mailboxDailyCap(paused, DEFAULT_WARMUP, NOW)).toBe(0)
    const elapsed = { ...base, warmupStartedAt: weeksAgo(10), pausedUntil: new Date(NOW.getTime() - 1000) }
    expect(mailboxDailyCap(elapsed, DEFAULT_WARMUP, NOW)).toBe(25)
  })

  it('clamps a future warmupStartedAt to week 0 (clock-skew safety)', () => {
    const future = { ...base, warmupStartedAt: new Date(NOW.getTime() + WEEK) }
    expect(mailboxDailyCap(future, DEFAULT_WARMUP, NOW)).toBe(10)
  })
})

describe('mailboxDailyStatus', () => {
  it('projects cap/remaining and ramp progress for a never-sent mailbox', () => {
    expect(mailboxDailyStatus(base, 0, DEFAULT_WARMUP, NOW)).toEqual({
      cap: 10, used: 0, remaining: 10, pausedUntil: null, rampWeek: 0, rampWeeks: 4, steadyStatePerDay: 25,
    })
  })

  it('clamps remaining at 0 when used exceeds the cap', () => {
    const s = mailboxDailyStatus({ ...base, warmupStartedAt: weeksAgo(2) }, 100, DEFAULT_WARMUP, NOW)
    expect(s.cap).toBe(17) // week-2 ramp step
    expect(s.remaining).toBe(0)
    expect(s.rampWeek).toBe(2)
  })

  it('reports a future pause (cap 0); an elapsed pause reads as not paused', () => {
    const future = new Date(NOW.getTime() + 1000)
    const paused = mailboxDailyStatus({ ...base, pausedUntil: future }, 0, DEFAULT_WARMUP, NOW)
    expect(paused.cap).toBe(0)
    expect(paused.remaining).toBe(0)
    expect(paused.pausedUntil).toEqual(future)

    const elapsed = mailboxDailyStatus({ ...base, pausedUntil: new Date(NOW.getTime() - 1000) }, 0, DEFAULT_WARMUP, NOW)
    expect(elapsed.pausedUntil).toBeNull()
    expect(elapsed.cap).toBe(10)
  })
})

describe('warmupWeeksElapsed', () => {
  it('reads 0 for a never-sent mailbox', () => {
    expect(warmupWeeksElapsed(base, DEFAULT_WARMUP, NOW)).toBe(0)
  })

  it('counts completed weeks during the ramp', () => {
    expect(warmupWeeksElapsed({ ...base, warmupStartedAt: weeksAgo(2) }, DEFAULT_WARMUP, NOW)).toBe(2)
  })

  it('saturates at rampWeeks once the ramp is over', () => {
    expect(warmupWeeksElapsed({ ...base, warmupStartedAt: weeksAgo(10) }, DEFAULT_WARMUP, NOW))
      .toBe(DEFAULT_WARMUP.rampWeeks)
  })

  it('clamps a future start to 0 (clock skew)', () => {
    expect(warmupWeeksElapsed({ ...base, warmupStartedAt: new Date(NOW.getTime() + WEEK) }, DEFAULT_WARMUP, NOW))
      .toBe(0)
  })
})

const WEEK = 7 * 24 * 60 * 60 * 1000
