import { describe, it, expect } from 'vitest'
import {
  DEFAULT_WARMUP,
  mailboxDailyCap,
  mailboxDailyStatus,
  pickFromMailboxPool,
  type MailboxDailyStatus,
  warmupWeeksElapsed,
  type MailboxWarmupState,
} from './warmup'

const NOW = new Date('2026-06-21T12:00:00Z')
const weeksAgo = (n: number) => new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000)

const base: MailboxWarmupState = {
  warmupStartedAt: null,
  dailyCapOverride: null,
  pausedUntil: null,
  sendRefusal: null,
}

describe('mailboxDailyCap', () => {
  it('never-sent mailbox sits at the day-1 start cap', () => {
    expect(mailboxDailyCap(base, DEFAULT_WARMUP, NOW)).toBe(10)
  })

  it('an explicit override is the cap and replaces the ramp — above or below it', () => {
    expect(mailboxDailyCap({ ...base, dailyCapOverride: 3 }, DEFAULT_WARMUP, NOW)).toBe(3)
    expect(mailboxDailyCap({ ...base, dailyCapOverride: 50 }, DEFAULT_WARMUP, NOW)).toBe(50)
    const wk3 = { ...base, warmupStartedAt: weeksAgo(3) }
    expect(mailboxDailyCap({ ...wk3, dailyCapOverride: 12 }, DEFAULT_WARMUP, NOW)).toBe(12)
    expect(mailboxDailyCap({ ...wk3, dailyCapOverride: 200 }, DEFAULT_WARMUP, NOW)).toBe(200)
  })

  it('treats dailyCapOverride=0 as a hard block, not "no override"', () => {
    expect(mailboxDailyCap({ ...base, dailyCapOverride: 0 }, DEFAULT_WARMUP, NOW)).toBe(0)
    expect(
      mailboxDailyCap({ ...base, warmupStartedAt: weeksAgo(3), dailyCapOverride: 0 }, DEFAULT_WARMUP, NOW),
    ).toBe(0)
  })

  it('ramps linearly (floored) from start to steady over rampWeeks when no override', () => {
    const at = (n: number) =>
      mailboxDailyCap({ ...base, warmupStartedAt: weeksAgo(n) }, DEFAULT_WARMUP, NOW)
    expect(at(0)).toBe(10)
    expect(at(1)).toBe(13)
    expect(at(2)).toBe(17)
    expect(at(3)).toBe(21)
    expect(at(4)).toBe(25) // ramp complete → steady
    expect(at(10)).toBe(25) // stays at steady
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
      cap: 10, used: 0, remaining: 10, pausedUntil: null, heldUntil: null, rampWeek: 0, rampWeeks: 4, steadyStatePerDay: 25,
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

  it('holds a refused mailbox until the next UTC day after the latest refusal', () => {
    const state = {
      ...base,
      warmupStartedAt: weeksAgo(10),
      sendRefusal: { since: '2026-06-20T09:00:00.000Z', lastAt: '2026-06-21T11:30:00.000Z', detail: '550 5.4.6', sentThatDay: 25 },
    }
    const nextUtcDay = new Date('2026-06-22T00:00:00.000Z')
    const held = mailboxDailyStatus(state, 0, DEFAULT_WARMUP, NOW)
    expect(held.cap).toBe(0)
    expect(held.heldUntil).toEqual(nextUtcDay)

    const probe = mailboxDailyStatus(state, 0, DEFAULT_WARMUP, nextUtcDay)
    expect(probe.heldUntil).toBeNull()
    expect(probe.cap).toBe(25)
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

describe('pickFromMailboxPool', () => {
  const entry = (identityId: string, cap: number, used: number, extra: Partial<MailboxDailyStatus> = {}) => ({
    identityId,
    cap,
    used,
    remaining: Math.max(0, cap - used),
    pausedUntil: null,
    heldUntil: null,
    rampWeek: 0,
    rampWeeks: 4,
    steadyStatePerDay: 25,
    ...extra,
  })
  const t = (iso: string) => new Date(iso)

  it('takes the first mailbox with sends left, in list order, and totals the pool', () => {
    const pick = pickFromMailboxPool([entry('a', 10, 10), entry('b', 25, 3), entry('c', 25, 0)])
    expect(pick).toEqual({ kind: 'ready', identityId: 'b', cap: 60, used: 13, remaining: 47 })
  })

  it('is exhausted with no resume time when any mailbox merely hit its cap', () => {
    const pick = pickFromMailboxPool([entry('a', 10, 10), entry('b', 0, 0, { pausedUntil: t('2026-06-22T00:00:00Z') })])
    expect(pick).toEqual({ kind: 'exhausted', cap: 10, used: 10, remaining: 0, resumesAt: null })
  })

  it('resumes at the earliest pause or hold when every mailbox waits on one', () => {
    const pick = pickFromMailboxPool([
      entry('a', 0, 0, { pausedUntil: t('2026-06-25T00:00:00Z') }),
      entry('b', 0, 0, { heldUntil: t('2026-06-22T00:00:00Z') }),
    ])
    expect(pick).toMatchObject({ kind: 'exhausted', resumesAt: t('2026-06-22T00:00:00Z') })
  })

  it('a mailbox paused and held at once waits for the later of the two', () => {
    const pick = pickFromMailboxPool([entry('a', 0, 0, { pausedUntil: t('2026-06-21T18:00:00Z'), heldUntil: t('2026-06-22T00:00:00Z') })])
    expect(pick).toMatchObject({ resumesAt: t('2026-06-22T00:00:00Z') })
  })

  it('an empty pool is exhausted with nothing to wait for', () => {
    expect(pickFromMailboxPool([])).toEqual({ kind: 'exhausted', cap: 0, used: 0, remaining: 0, resumesAt: null })
  })
})
