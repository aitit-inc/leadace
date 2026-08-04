import { describe, it, expect } from 'vitest'
import {
  buildFunnel,
  buildJournal,
  buildTrend,
  computeDeltaPct,
  parseLearnings,
  periodToWindow,
  replyRate,
  trendWindowStartIso,
} from './dashboard'

describe('computeDeltaPct', () => {
  it('returns the rounded percentage change', () => {
    expect(computeDeltaPct(120, 100)).toBe(20)
    expect(computeDeltaPct(80, 100)).toBe(-20)
  })

  it('returns null when the previous window was zero (no meaningful baseline)', () => {
    expect(computeDeltaPct(5, 0)).toBeNull()
    expect(computeDeltaPct(0, 0)).toBeNull()
  })
})

describe('buildFunnel', () => {
  it('computes each stage conversion relative to the stage above', () => {
    const f = buildFunnel({ sent: 100, reached: 25, engaged: 10, won: 2 })
    expect(f.map((s) => s.key)).toEqual(['sent', 'reached', 'engaged', 'won'])
    expect(f[0]).toEqual({ key: 'sent', count: 100, conversionFromPrev: null })
    expect(f[1]).toEqual({ key: 'reached', count: 25, conversionFromPrev: 25 })
    expect(f[2]).toEqual({ key: 'engaged', count: 10, conversionFromPrev: 40 })
    expect(f[3]).toEqual({ key: 'won', count: 2, conversionFromPrev: 20 })
  })

  it('returns null conversion (not NaN/Infinity) when the prior stage is zero', () => {
    const f = buildFunnel({ sent: 0, reached: 0, engaged: 0, won: 0 })
    expect(f.every((s) => s.count === 0)).toBe(true)
    expect(f[1]!.conversionFromPrev).toBeNull()
    expect(f[3]!.conversionFromPrev).toBeNull()
  })

  it('caps conversion at 100% when a later stage exceeds the prior (lagged attribution)', () => {
    const f = buildFunnel({ sent: 100, reached: 10, engaged: 20, won: 1 })
    expect(f[2]!.conversionFromPrev).toBe(100)
  })
})

describe('buildTrend', () => {
  const now = new Date('2026-06-14T12:00:00.000Z')

  it('always returns 30 daily buckets oldest→newest, zero-filling missing days', () => {
    const t = buildTrend(
      now,
      [
        { day: '2026-06-14', count: 5 },
        { day: '2026-06-01', count: 3 },
      ],
      [{ day: '2026-06-14', count: 2 }],
    )
    expect(t).toHaveLength(30)
    expect(t[0]!.date).toBe('2026-05-16')
    expect(t[29]).toEqual({ date: '2026-06-14', sent: 5, responses: 2 })
    expect(t.find((p) => p.date === '2026-06-01')).toEqual({ date: '2026-06-01', sent: 3, responses: 0 })
    expect(t.find((p) => p.date === '2026-06-02')).toEqual({ date: '2026-06-02', sent: 0, responses: 0 })
  })
})

describe('trendWindowStartIso', () => {
  const now = new Date('2026-06-14T12:00:00.000Z')

  it('is UTC midnight 29 days before now (the oldest of 30 buckets)', () => {
    expect(trendWindowStartIso(now)).toBe('2026-05-16T00:00:00.000Z')
  })

  it("matches buildTrend's oldest day key, so the SQL floor and zero-fill keys align", () => {
    const t = buildTrend(now, [], [])
    expect(trendWindowStartIso(now).slice(0, 10)).toBe(t[0]!.date)
  })
})

describe('replyRate', () => {
  it('is a one-decimal percentage of approached', () => {
    expect(replyRate(12, 142)).toBe(8.5)
  })
  it('is 0 when nothing was approached', () => {
    expect(replyRate(0, 0)).toBe(0)
  })
})

describe('periodToWindow', () => {
  const now = new Date('2026-06-14T00:00:00.000Z')

  it('uses equal-length current/previous windows for 7d and 30d', () => {
    const w7 = periodToWindow('7d', now)
    expect(w7.curStart.toISOString()).toBe('2026-06-07T00:00:00.000Z')
    expect(w7.prevStart.toISOString()).toBe('2026-05-31T00:00:00.000Z')

    const w30 = periodToWindow('30d', now)
    expect(w30.curStart.toISOString()).toBe('2026-05-15T00:00:00.000Z')
    expect(w30.prevStart.toISOString()).toBe('2026-04-15T00:00:00.000Z')
  })

  it("collapses both bounds to the epoch for 'all' so previous is structurally zero", () => {
    const w = periodToWindow('all', now)
    expect(w.curStart.getTime()).toBe(0)
    expect(w.prevStart.getTime()).toBe(0)
  })
})

describe('parseLearnings', () => {
  it('parses a well-formed entry and trims the evidence tail', () => {
    const entries = parseLearnings(
      '[targeting] [2026-06-10] SaaS firms under 50 staff reply best — evidence: metric=replyRate, n=42',
    )
    expect(entries).toEqual([
      {
        stage: 'targeting',
        date: '2026-06-10',
        claim: 'SaaS firms under 50 staff reply best',
        evidence: 'metric=replyRate, n=42',
      },
    ])
  })

  it('keeps the claim when no evidence tail is present', () => {
    const entries = parseLearnings('[body] [2026-06-01] short openers outperform long ones')
    expect(entries).toEqual([
      { stage: 'body', date: '2026-06-01', claim: 'short openers outperform long ones', evidence: null },
    ])
  })

  it('drops [retired] tombstones and unrecognized stages', () => {
    const entries = parseLearnings(
      [
        '[retired] [2026-05-01] old claim — evidence: metric=x, n=9',
        '[bogus] [2026-05-02] not a real stage',
        '[channel] [2026-06-02] LinkedIn DMs land warmer when referencing a hire — evidence: metric=replyRate, n=31',
      ].join('\n'),
    )
    expect(entries).toEqual([
      {
        stage: 'channel',
        date: '2026-06-02',
        claim: 'LinkedIn DMs land warmer when referencing a hire',
        evidence: 'metric=replyRate, n=31',
      },
    ])
  })

  it('parses [discovery] entries', () => {
    const entries = parseLearnings(
      '[discovery] [2026-07-01] github-topics sources reply best — evidence: metric=replyRate, n=34',
    )
    expect(entries).toEqual([
      {
        stage: 'discovery',
        date: '2026-07-01',
        claim: 'github-topics sources reply best',
        evidence: 'metric=replyRate, n=34',
      },
    ])
  })

  it('skips headers/blank lines and tolerates a leading markdown bullet', () => {
    const entries = parseLearnings(
      ['# Learnings Log', '', '- [timing] [2026-06-05] 3-month recontacts convert — evidence: metric=meetingRate, n=12'].join(
        '\n',
      ),
    )
    expect(entries).toEqual([
      { stage: 'timing', date: '2026-06-05', claim: '3-month recontacts convert', evidence: 'metric=meetingRate, n=12' },
    ])
  })

  it('returns entries newest-first regardless of document order (so the truncated glance is deterministic)', () => {
    const entries = parseLearnings(
      [
        '[targeting] [2026-05-01] older claim',
        '[body] [2026-06-15] newer claim',
        '[channel] [2026-06-01] middle claim',
      ].join('\n'),
    )
    expect(entries.map((e) => e.date)).toEqual(['2026-06-15', '2026-06-01', '2026-05-01'])
  })

  it('returns an empty list for null or blank content', () => {
    expect(parseLearnings(null)).toEqual([])
    expect(parseLearnings('')).toEqual([])
    expect(parseLearnings('\n\n')).toEqual([])
  })
})

describe('buildJournal', () => {
  const variants = [
    { variantId: 'roi-focus', label: 'ROI focus', createdAt: '2026-07-10T09:00:00Z' },
    { variantId: 'pain-first', label: null, createdAt: '2026-05-01T09:00:00Z' },
  ]

  it('maps rotation vs dominance archives and reads pre-Phase-C entries null-safe', () => {
    const events = buildJournal(
      [
        {
          cycleDate: '2026-07-14',
          archived: [
            { variantId: 'pain-first', pBest: 0.05, n: 42, reason: 'stagnation' },
            { variantId: 'legacy-v1' },
          ],
        },
      ],
      variants,
      [],
      '2026-07-12',
    )
    expect(events).toEqual([
      {
        date: '2026-07-14',
        kind: 'variant_archived',
        variantId: 'legacy-v1',
        label: null,
        reason: 'dominated',
        pBest: null,
        n: null,
      },
      {
        date: '2026-07-14',
        kind: 'variant_archived',
        variantId: 'pain-first',
        label: null,
        reason: 'stagnation',
        pBest: 0.05,
        n: 42,
      },
    ])
  })

  it('windows variant additions and escalations against windowStartDay', () => {
    const events = buildJournal(
      [],
      variants,
      [
        { title: 'Revisit strategy', createdAt: '2026-07-12T00:30:00Z' },
        { title: 'Stale escalation', createdAt: '2026-06-01T00:30:00Z' },
      ],
      '2026-06-16',
    )
    expect(events).toEqual([
      { date: '2026-07-12', kind: 'strategy_escalated', title: 'Revisit strategy' },
      { date: '2026-07-10', kind: 'variant_added', variantId: 'roi-focus', label: 'ROI focus' },
    ])
  })

  it('sorts newest-first with added before archived within a day', () => {
    const events = buildJournal(
      [{ cycleDate: '2026-07-10', archived: [{ variantId: 'pain-first', pBest: 0.03, n: 35, reason: 'stagnation' }] }],
      variants,
      [],
      '2026-06-16',
    )
    expect(events.map((e) => e.kind)).toEqual(['variant_added', 'variant_archived'])
  })
})
