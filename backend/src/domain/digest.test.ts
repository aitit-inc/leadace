import { describe, expect, it } from 'vitest'
import { buildDigest, newlyRetiredClaims, type DigestInput } from './digest'
import type { DashboardSummary } from './dashboard'

const emptySummary: DashboardSummary = {
  period: '30d',
  kpis: {
    approached: { current: 0, previous: 0, deltaPct: null },
    delivered: { current: 0, previous: 0, deltaPct: null },
    reached: { current: 0, previous: 0, deltaPct: null },
    engaged: { current: 0, previous: 0, deltaPct: null },
    won: { current: 0, previous: 0, deltaPct: null },
  },
  funnel: [],
  trend: [],
  replyRateTrend: { previous: 0, current: 0 },
  learning: { bestSubject: null, angles: [], needsNewAngle: false, state: 'learning', log: [] },
  journal: [],
  lastCycleDate: null,
  rejections: {
    total: 0,
    topReasons: [],
    productSignal: null,
    budgetSignal: null,
    decisionMakers: [],
    notRelevant: [],
    recontactSoon: null,
  },
  segments: [],
  recentActivity: [],
  attention: [],
}

const input = (over: Omit<Partial<DigestInput>, 'summary'> & { summary?: Partial<DashboardSummary> } = {}): DigestInput => ({
  projectName: 'Acme',
  sinceDay: '2026-09-14',
  today: '2026-09-18',
  retiredClaims: [],
  ...over,
  summary: { ...emptySummary, ...over.summary },
})

describe('buildDigest', () => {
  it('says nothing while no change is in and the heartbeat is not due', () => {
    expect(
      buildDigest(
        input({
          summary: { kpis: { ...emptySummary.kpis, approached: { current: 40, previous: 0, deltaPct: null } } },
        }),
      ),
    ).toBeNull()
  })

  it('reports a change once the day it happened is complete, and not again after', () => {
    const journal: DashboardSummary['journal'] = [
      { date: '2026-09-18', kind: 'variant_added', variantId: 'v2', label: 'Cost saving' },
    ]
    // The day it happened is still in progress: the rest of it is unreported.
    expect(buildDigest(input({ today: '2026-09-18', summary: { journal } }))).toBeNull()
    expect(buildDigest(input({ today: '2026-09-19', summary: { journal } }))?.body).toContain('New angle: Cost saving')
    expect(buildDigest(input({ sinceDay: '2026-09-19', today: '2026-09-20', summary: { journal } }))).toBeNull()
  })

  it('leads with what was un-learned and counts it as a change', () => {
    const digest = buildDigest(input({ retiredClaims: ['Fresh-signal prospects reply more'] }))
    expect(digest?.subject).toBe('Acme: 1 change from what we learned')
    expect(digest?.body.split('\n').at(-1)).toBe(
      'Un-learned: "Fresh-signal prospects reply more" — the measurement it rested on was withdrawn',
    )
  })

  it('goes out on the heartbeat with nothing to report, once there is something to show', () => {
    const digest = buildDigest(
      input({
        today: '2026-09-21',
        summary: { kpis: { ...emptySummary.kpis, approached: { current: 40, previous: 30, deltaPct: 33 } } },
      }),
    )
    expect(digest?.subject).toBe('Acme: no change since 2026-09-14')
    expect(digest?.body).toContain('Contacted 40 prospects')
    expect(digest?.body).toContain('Nothing — the system kept running on what it already learned.')
  })

  it('stays silent on the heartbeat for a project that sent nothing and learned nothing', () => {
    expect(buildDigest(input({ today: '2026-09-30' }))).toBeNull()
  })

  it('reports segments and rejection reasons in the dashboard’s own words', () => {
    const digest = buildDigest(
      input({
        today: '2026-09-21',
        summary: {
          segments: [
            {
              axis: 'industry',
              rows: [
                { value: 'software_tech', sent: 42, replied: 5, replyRate: 11.9 },
                { value: 'hardware_industrial', sent: 44, replied: 2, replyRate: 4.5 },
              ],
            },
          ],
          rejections: {
            ...emptySummary.rejections,
            total: 20,
            topReasons: [{ reason: 'not_relevant', count: 8, percentage: 40 }],
            productSignal: {
              count: 4,
              quotes: [{ freeText: 'No Salesforce sync', prospectName: 'Taro', organizationName: 'Acme Inc.' }],
            },
          },
        },
      }),
    )
    expect(digest?.body).toContain('Industry: Software tech 11.9% (5/42) · Hardware industrial 4.5% (2/44)')
    expect(digest?.body).toContain('Why 20 said no: Not relevant 40%')
    expect(digest?.body).toContain('  "No Salesforce sync" — Taro, Acme Inc.')
  })
})

describe('newlyRetiredClaims', () => {
  const before = [
    '# Learnings',
    '- [targeting] [2026-09-01] SaaS under 50 replies twice as often — evidence: metric=x, n=40',
    '- [retired] [2026-08-02] An older mistake — evidence: metric=y, n=10',
  ].join('\n')

  it('returns the claims tombstoned since the earlier version', () => {
    const after = before.replace('[targeting] [2026-09-01]', '[retired] [2026-09-01]')
    expect(newlyRetiredClaims(before, after)).toEqual(['SaaS under 50 replies twice as often'])
  })

  it('ignores tombstones that were already there', () => {
    expect(newlyRetiredClaims(before, before)).toEqual([])
  })

  it('treats every tombstone as new when there is no earlier version', () => {
    expect(newlyRetiredClaims(null, before)).toEqual(['An older mistake'])
  })
})
