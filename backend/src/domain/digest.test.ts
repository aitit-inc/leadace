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
  learning: { angles: [], needsNewAngle: false, state: 'learning' },
  journal: [],
  loop: {
    changes: 0,
    bySignal: { replies: 0, declines: 0, bounces: 0, discovery: 0, person: 0 },
    frame: { start: null, trials: 0, positive: 0 },
    previousFrame: null,
  },
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
  research: { researched: 0, notFit: 0, notFitPercent: 0, noContact: 0, notFitExamples: [] },
  responders: [],
  recentActivity: [],
  attention: [],
}

const input = (over: Omit<Partial<DigestInput>, 'summary'> & { summary?: Partial<DashboardSummary> } = {}): DigestInput => ({
  projectName: 'Acme',
  sinceDay: '2026-09-14',
  today: '2026-09-18',
  firstSendDay: null,
  ...over,
  summary: { ...emptySummary, ...over.summary },
})

describe('buildDigest', () => {
  describe('first report', () => {
    const research = {
      researched: 60,
      notFit: 24,
      notFitPercent: 40,
      noContact: 8,
      notFitExamples: [{ organizationName: 'Big Corp', reason: 'Runs its own\n in-house exam.' }],
    }
    const kpis = { ...emptySummary.kpis, approached: { current: 25, previous: 0, deltaPct: null } }

    it('goes out the day after the first send with no change to report', () => {
      const digest = buildDigest(input({ sinceDay: '2026-09-16', today: '2026-09-18', firstSendDay: '2026-09-17', summary: { kpis, research } }))
      expect(digest?.subject).toBe('Acme: first report: 60 looked at, 25 contacted')
      expect(digest?.body).toContain("Ace looked at 60 companies: 24 (40%) didn't fit your target or couldn't be confirmed, 8 fit but publish no way to reach them.")
      expect(digest?.body).toContain("Why companies didn't fit (latest)\nBig Corp: Runs its own in-house exam.")
      expect(digest?.body).toContain('Who responded\nNo one yet.')
    })

    it('waits while the first send is still in the day in progress, and goes once only', () => {
      const summary = { kpis, research }
      expect(buildDigest(input({ sinceDay: '2026-09-16', today: '2026-09-17', firstSendDay: '2026-09-17', summary }))).toBeNull()
      expect(buildDigest(input({ sinceDay: '2026-09-18', today: '2026-09-19', firstSendDay: '2026-09-17', summary }))).toBeNull()
    })
  })

  it('does not call a no silence', () => {
    const digest = buildDigest(
      input({
        today: '2026-09-21',
        summary: {
          kpis: {
            ...emptySummary.kpis,
            approached: { current: 25, previous: 0, deltaPct: null },
            engaged: { current: 1, previous: 0, deltaPct: null },
          },
        },
      }),
    )
    expect(digest?.body).toContain('Who responded\nNo one has shown interest yet.')
  })

  it('names who responded and leaves out research that did not happen', () => {
    const digest = buildDigest(
      input({
        today: '2026-09-21',
        summary: {
          kpis: { ...emptySummary.kpis, approached: { current: 25, previous: 0, deltaPct: null } },
          responders: [
            { prospectName: 'Jane Doe', organizationName: 'Acme Exams', level: 'positive' },
            { prospectName: 'Foo Inc', organizationName: 'Foo Inc', level: 'interest' },
          ],
        },
      }),
    )
    expect(digest?.body).toContain('Who responded\nPositive: Jane Doe, Acme Exams\nWith interest: Foo Inc')
    expect(digest?.body).not.toContain('Ace looked at')
    expect(digest?.body).not.toContain("didn't fit (latest)")
  })

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
      { date: '2026-09-18', kind: 'option', target: 'variant', optionId: 'v2', label: 'Cost saving', op: 'add', actor: 'ace', reason: null, evidence: null },
    ]
    // The day it happened is still in progress: the rest of it is unreported.
    expect(buildDigest(input({ today: '2026-09-18', summary: { journal } }))).toBeNull()
    expect(buildDigest(input({ today: '2026-09-19', summary: { journal } }))?.body).toContain('New angle: Cost saving')
    expect(buildDigest(input({ sinceDay: '2026-09-19', today: '2026-09-20', summary: { journal } }))).toBeNull()
  })

  it('says who changed what and why', () => {
    const journal: DashboardSummary['journal'] = [
      { date: '2026-09-18', kind: 'rule_archive', target: 'strategy', optionId: 'yc-hn', label: null, reason: 'lost', evidence: { pBest: 0.01, n: 74 } },
      { date: '2026-09-18', kind: 'option', target: 'strategy', optionId: 'yc-hn', label: null, op: 'restore', actor: 'user', reason: 'still the best source', evidence: null },
      { date: '2026-09-18', kind: 'document', target: 'sales_strategy', actor: 'ace', reason: 'Not a fit: agencies', evidence: { signals: ['declines', 'person'] } },
    ]
    const digest = buildDigest(input({ today: '2026-09-19', summary: { journal } }))
    // The person's own restore is reported but is not something Ace learned.
    expect(digest?.subject).toBe('Acme: 2 changes from what we learned')
    const body = digest?.body ?? ''
    expect(body).toContain('Search strategy retired: yc-hn (another strategy won)')
    expect(body).toContain('Search strategy back: yc-hn (by you) — still the best source')
    expect(body).toContain('Sales strategy adjusted (on the noes, your corrections) — Not a fit: agencies')
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
    expect(digest?.subject).toBe('Acme: no change from what we learned since 2026-09-14')
    expect(digest?.body).toContain('Contacted 40 prospects · positive 2.5% (was 3.3%) · with interest 7.5% (was 6.7%) · engaged 0 · won 0')
    expect(digest?.body).toContain('Nothing — the system kept running on what it already learned.')
  })

  it('reports the setup without counting it as learned', () => {
    const journal: DashboardSummary['journal'] = [
      { date: '2026-09-17', kind: 'option', target: 'variant', optionId: 'v1', label: 'Cost saving', op: 'add', actor: 'ace', reason: null, evidence: null },
      { date: '2026-09-17', kind: 'document', target: 'sales_strategy', actor: 'ace', reason: null, evidence: null },
    ]
    const digest = buildDigest(input({ today: '2026-09-18', summary: { journal } }))
    expect(digest?.subject).toBe('Acme: 2 updates since 2026-09-14')
    expect(digest?.body).toContain('New angle: Cost saving')
  })

  it('lists what needs the person, the spent allowance included', () => {
    const digest = buildDigest(
      input({
        today: '2026-09-21',
        summary: {
          kpis: { ...emptySummary.kpis, approached: { current: 50, previous: 0, deltaPct: null } },
          attention: [
            { kind: 'hot_leads', count: 1 },
            { kind: 'quota_exhausted', allowance: 'contacted', constraint: 'lifetime' },
          ],
        },
      }),
    )
    expect(digest?.body).toContain(
      'Needs you\n1 meeting request waiting — book the call.\nEvery prospect in your plan has been contacted. Follow-ups still go out; open the plans page to reach new ones.',
    )
  })

  it('counts what Ace changed by what it rested on, and this frame against the one before', () => {
    const digest = buildDigest(
      input({
        today: '2026-10-20',
        summary: {
          kpis: { ...emptySummary.kpis, approached: { current: 40, previous: 0, deltaPct: null } },
          loop: {
            changes: 3,
            bySignal: { replies: 1, declines: 0, bounces: 1, discovery: 2, person: 0 },
            frame: { start: { day: '2026-10-19', by: 'ace', reason: 'no positive in 120 trials' }, trials: 41.6, positive: 1 },
            previousFrame: { start: null, trials: 1240.2, positive: 2 },
          },
        },
      }),
    )
    expect(digest?.body).toContain(
      'How Ace learned (last 30 days)\n3 changes by Ace, resting on: reply rates 1 · bounces 1 · what discovery found 2\nThis frame (since 2026-10-19): 1 positive of 42 counted (2.4%) · the frame before: 2 positive of 1240 counted (0.2%)',
    )
  })

  it('stays silent on the heartbeat for a project that sent nothing and learned nothing', () => {
    expect(buildDigest(input({ today: '2026-09-30' }))).toBeNull()
  })

  it('still goes out on the heartbeat while something needs the person', () => {
    const attention: DashboardSummary['attention'] = [{ kind: 'quota_exhausted', allowance: 'contacted', constraint: 'lifetime' }]
    expect(buildDigest(input({ today: '2026-09-20', summary: { attention } }))).toBeNull()
    expect(buildDigest(input({ today: '2026-09-30', summary: { attention } }))?.body).toContain('Every prospect in your plan has been contacted.')
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
