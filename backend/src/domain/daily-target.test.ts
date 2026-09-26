import { describe, expect, it } from 'vitest'
import { planPace, resolveDailyTarget, runnableNewProspects, shortfallReason, weekdaysBetween, type PaceInput } from './daily-target'

const at = (iso: string) => new Date(iso)
const month = (remaining: number, creditsPay = false): PaceInput => ({
  kind: 'monthly',
  remaining,
  limit: 100,
  periodStart: at('2026-09-01T00:00:00Z'),
  periodEnd: at('2026-10-01T00:00:00Z'),
  creditsPay,
})

describe('weekdaysBetween', () => {
  it('counts UTC Monday to Friday, today included', () => {
    expect(weekdaysBetween(at('2026-09-01T09:00:00Z'), at('2026-10-01T00:00:00Z'))).toBe(22)
    expect(weekdaysBetween(at('2026-09-28T15:00:00Z'), at('2026-10-01T00:00:00Z'))).toBe(3)
  })
  it('never divides by zero over a weekend-only span', () => {
    expect(weekdaysBetween(at('2026-09-26T00:00:00Z'), at('2026-09-28T00:00:00Z'))).toBe(1)
  })
})

describe('planPace', () => {
  it('spreads what is left of a monthly allowance over the weekdays left and caps the day there', () => {
    expect(planPace(month(100), at('2026-09-01T09:00:00Z'))).toEqual({ perDay: 5, cap: 5 })
    expect(planPace(month(30), at('2026-09-28T09:00:00Z'))).toEqual({ perDay: 10, cap: 10 })
    expect(planPace(month(0), at('2026-09-28T09:00:00Z'))).toEqual({ perDay: 0, cap: 0 })
  })
  it('keeps the average rate and lifts the cap when credits pay past the allowance', () => {
    expect(planPace(month(0, true), at('2026-09-28T09:00:00Z'))).toEqual({ perDay: 5, cap: null })
    expect(planPace(month(30, true), at('2026-09-28T09:00:00Z'))).toEqual({ perDay: 10, cap: null })
  })
  it('gives Free 5 a day, capped by what is left of its lifetime allowance', () => {
    expect(planPace({ kind: 'lifetime', remaining: 30 }, at('2026-09-01T00:00:00Z'))).toEqual({ perDay: 5, cap: 30 })
    expect(planPace({ kind: 'lifetime', remaining: 3 }, at('2026-09-01T00:00:00Z'))).toEqual({ perDay: 3, cap: 3 })
  })
  it('sets no pace for an unmetered plan', () => {
    expect(planPace({ kind: 'unlimited' }, at('2026-09-01T00:00:00Z'))).toBeNull()
  })
})

describe('resolveDailyTarget', () => {
  it('takes the setting, else the plan, else the fixed default', () => {
    expect(resolveDailyTarget(12, { perDay: 5, cap: 5 })).toEqual({ count: 12, source: 'settings' })
    expect(resolveDailyTarget(null, { perDay: 5, cap: 5 })).toEqual({ count: 5, source: 'plan' })
    expect(resolveDailyTarget(null, null)).toEqual({ count: 20, source: 'fixed' })
  })
})

describe('runnableNewProspects', () => {
  it('names the tightest bound', () => {
    expect(runnableNewProspects(10, 25, { perDay: 14, cap: 14 })).toEqual({ count: 10, limitedBy: 'target' })
    expect(runnableNewProspects(30, 13, { perDay: 14, cap: 14 })).toEqual({ count: 13, limitedBy: 'mailbox' })
    expect(runnableNewProspects(30, 25, { perDay: 14, cap: 14 })).toEqual({ count: 14, limitedBy: 'plan' })
  })
  it('does not cap by a pace credits pay past, nor by a plan without one', () => {
    expect(runnableNewProspects(30, 50, { perDay: 14, cap: null })).toEqual({ count: 30, limitedBy: 'target' })
    expect(runnableNewProspects(30, 50, null)).toEqual({ count: 30, limitedBy: 'target' })
  })
  it('leaves drafts held for review unbounded by the mailboxes', () => {
    expect(runnableNewProspects(30, null, null)).toEqual({ count: 30, limitedBy: 'target' })
    expect(runnableNewProspects(30, null, { perDay: 14, cap: 14 })).toEqual({ count: 14, limitedBy: 'plan' })
  })
  it('reads a spent mailbox as zero', () => {
    expect(runnableNewProspects(10, -2, null)).toEqual({ count: 0, limitedBy: 'mailbox' })
  })
})

describe('shortfallReason', () => {
  const runnable = (count: number, limitedBy: 'target' | 'mailbox' | 'plan') => ({ count, limitedBy })
  const done = { kind: 'reached' } as const
  it('is silent when the day reached its target', () => {
    expect(shortfallReason({ target: 10, runnable: runnable(10, 'target'), reached: 10, stop: done })).toBeNull()
  })
  it('names the capacity or plan bound the day stopped at', () => {
    expect(shortfallReason({ target: 30, runnable: runnable(13, 'mailbox'), reached: 13, stop: done })).toContain('mailbox')
    expect(shortfallReason({ target: 30, runnable: runnable(5, 'plan'), reached: 5, stop: done })).toContain('allowance')
  })
  it('names what ran out of supply', () => {
    expect(shortfallReason({ target: 20, runnable: runnable(20, 'target'), reached: 4, stop: { kind: 'dry' } })).toBe('supply — discovery found nothing new to reach')
    expect(shortfallReason({ target: 20, runnable: runnable(20, 'target'), reached: 11, stop: { kind: 'list_spent', failed: 0 } })).toBe('supply — the rest were skipped')
    expect(shortfallReason({ target: 20, runnable: runnable(20, 'target'), reached: 0, stop: { kind: 'no_discovery', why: 'no_strategies' } })).toBe('supply — no discovery strategies')
    expect(shortfallReason({ target: 20, runnable: runnable(20, 'target'), reached: 9, stop: { kind: 'pass_cap' } })).toContain('discovery passes')
  })
  it('names send failures', () => {
    expect(shortfallReason({ target: 20, runnable: runnable(20, 'target'), reached: 17, stop: { kind: 'list_spent', failed: 3 } })).toBe('3 failed')
  })
})
