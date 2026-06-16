import { describe, it, expect } from 'vitest'
import {
  buildFunnel,
  buildTrend,
  computeDeltaPct,
  deriveAttentionItems,
  parseLearnings,
  periodToWindow,
  replyRate,
  trendWindowStartIso,
  type AttentionInput,
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
      { stage: 'targeting', date: '2026-06-10', claim: 'SaaS firms under 50 staff reply best' },
    ])
  })

  it('keeps the claim when no evidence tail is present', () => {
    const entries = parseLearnings('[body] [2026-06-01] short openers outperform long ones')
    expect(entries).toEqual([{ stage: 'body', date: '2026-06-01', claim: 'short openers outperform long ones' }])
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
      { stage: 'channel', date: '2026-06-02', claim: 'LinkedIn DMs land warmer when referencing a hire' },
    ])
  })

  it('skips headers/blank lines and tolerates a leading markdown bullet', () => {
    const entries = parseLearnings(
      ['# Learnings Log', '', '- [timing] [2026-06-05] 3-month recontacts convert — evidence: metric=meetingRate, n=12'].join(
        '\n',
      ),
    )
    expect(entries).toEqual([{ stage: 'timing', date: '2026-06-05', claim: '3-month recontacts convert' }])
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

describe('deriveAttentionItems', () => {
  const clean: AttentionInput = {
    mcpConnected: true,
    compliance: { ready: true, missing: [] },
    gmailConnected: true,
    outboundChannelsConfigured: true,
    emailTemplateExists: true,
    quota: { exhausted: false, constraint: null },
    pendingDrafts: 0,
    hotLeadsRecent: 0,
  }

  it('returns nothing when everything is healthy', () => {
    expect(deriveAttentionItems(clean)).toEqual([])
  })

  it('surfaces hot leads first (revenue opportunity), then the review queue', () => {
    const items = deriveAttentionItems({ ...clean, hotLeadsRecent: 2, pendingDrafts: 4 })
    expect(items).toEqual([
      { kind: 'hot_leads', count: 2 },
      { kind: 'outreach_drafts', count: 4 },
    ])
  })

  it('orders blockers between the opportunity and the review queue', () => {
    const items = deriveAttentionItems({
      ...clean,
      hotLeadsRecent: 1,
      mcpConnected: false,
      compliance: { ready: false, missing: ['legalName'] },
      gmailConnected: false,
      outboundChannelsConfigured: false,
      emailTemplateExists: false,
      quota: { exhausted: true, constraint: 'monthly' },
      pendingDrafts: 3,
    })
    expect(items.map((i) => i.kind)).toEqual([
      'hot_leads',
      'mcp_not_connected',
      'compliance_incomplete',
      'gmail_disconnected',
      'no_outbound_channels',
      'email_template_missing',
      'quota_exhausted',
      'outreach_drafts',
    ])
  })

  it('omits quota_exhausted when there is no binding constraint', () => {
    const items = deriveAttentionItems({ ...clean, quota: { exhausted: true, constraint: null } })
    expect(items).toEqual([])
  })

  it('carries the compliance missing fields and quota constraint through', () => {
    const items = deriveAttentionItems({
      ...clean,
      compliance: { ready: false, missing: ['physicalAddress', 'defaultSenderCountry'] },
      quota: { exhausted: true, constraint: 'daily' },
    })
    expect(items).toContainEqual({ kind: 'compliance_incomplete', missing: ['physicalAddress', 'defaultSenderCountry'] })
    expect(items).toContainEqual({ kind: 'quota_exhausted', constraint: 'daily' })
  })
})
