import { describe, expect, it } from 'vitest'
import { buildDigest, type DigestInput } from './digest'
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
  reactionRates: { positive: { previous: 0, current: 0 }, interested: { previous: 0, current: 0 } },
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
      { date: '2026-09-18', kind: 'option', target: 'variant', optionId: 'v2', label: 'Cost saving', op: 'add', actor: 'ace', reason: null },
    ]
    // The day it happened is still in progress: the rest of it is unreported.
    expect(buildDigest(input({ today: '2026-09-18', summary: { journal } }))).toBeNull()
    expect(buildDigest(input({ today: '2026-09-19', summary: { journal } }))?.body).toContain('New angle: Cost saving')
    expect(buildDigest(input({ sinceDay: '2026-09-19', today: '2026-09-20', summary: { journal } }))).toBeNull()
  })

  it('says who changed what and why', () => {
    const journal: DashboardSummary['journal'] = [
      { date: '2026-09-18', kind: 'rule_archive', target: 'strategy', optionId: 'yc-hn', label: null, reason: 'lost', evidence: { pBest: 0.01, n: 74 } },
      { date: '2026-09-18', kind: 'option', target: 'strategy', optionId: 'yc-hn', label: null, op: 'restore', actor: 'user', reason: 'still the best source' },
      { date: '2026-09-18', kind: 'document', target: 'sales_strategy', actor: 'ace', reason: 'Not a fit: agencies' },
    ]
    const body = buildDigest(input({ today: '2026-09-19', summary: { journal } }))?.body ?? ''
    expect(body).toContain('Search strategy retired: yc-hn (another strategy won)')
    expect(body).toContain('Search strategy back: yc-hn (by you) — still the best source')
    expect(body).toContain('Sales strategy adjusted — Not a fit: agencies')
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
        summary: {
          kpis: { ...emptySummary.kpis, approached: { current: 40, previous: 30, deltaPct: 33 } },
          reactionRates: { positive: { previous: 3.3, current: 2.5 }, interested: { previous: 6.7, current: 7.5 } },
        },
      }),
    )
    expect(digest?.subject).toBe('Acme: no change since 2026-09-14')
    expect(digest?.body).toContain('Contacted 40 prospects · positive 2.5% (was 3.3%) · with interest 7.5% (was 6.7%) · engaged 0 · won 0')
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
                { value: 'software_tech', sent: 42, positiveRate: 4.8, interestedRate: 11.9 },
                { value: 'hardware_industrial', sent: 44, positiveRate: 0, interestedRate: 4.5 },
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
    expect(digest?.body).toContain(
      'Positive / with interest, of the prospects contacted:\nIndustry: Software tech 4.8% / 11.9% of 42 · Hardware industrial 0% / 4.5% of 44',
    )
    expect(digest?.body).toContain('Why 20 said no: Not relevant 40%')
    expect(digest?.body).toContain('  "No Salesforce sync" — Taro, Acme Inc.')
  })
})
