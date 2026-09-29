import type { Channel, RejectionRecontactWindow } from '../db/schema'
import type { AttentionItem } from './attention'
import { coarseIndustry } from './coarse-industry'
import type { LearningEntry } from './loop/learnings'
import { sendReaction, type Reaction, type ReactionLevel } from './loop/reaction'

export const DASHBOARD_PERIODS = ['7d', '30d', 'all'] as const
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]

export type KpiValue = {
  current: number
  previous: number
  deltaPct: number | null
}

export type FunnelStageKey = 'sent' | 'delivered' | 'reached' | 'engaged' | 'won'

export type FunnelStage = {
  key: FunnelStageKey
  count: number
  conversionFromPrev: number | null
}

export type DashboardTrendPoint = { date: string; sent: number; responses: number }

// Percentages of the sends or prospects counted: positive, and positive or
// interest (domain/loop/reaction).
export type ReactionRates = { positiveRate: number; interestedRate: number }

export type LearningAngle = ReactionRates & {
  variantId: string
  label: string | null
  total: number
  mature: boolean
  leader: boolean
}

export type DashboardLearning = {
  bestSubject: (ReactionRates & { pattern: string; mature: boolean; n: number }) | null
  angles: LearningAngle[]
  needsNewAngle: boolean
  state: 'learning' | 'optimizing'
  log: LearningEntry[]
}

export const JOURNAL_WINDOW_DAYS = 30

export type JournalEvent =
  | {
      date: string
      kind: 'variant_archived'
      variantId: string
      label: string | null
      reason: 'stagnation' | 'dominated'
      pBest: number | null
      n: number | null
    }
  | { date: string; kind: 'variant_added'; variantId: string; label: string | null }
  | { date: string; kind: 'strategy_escalated'; title: string }

export type JournalDecisionDay = {
  cycleDate: string
  archived: Array<{ variantId: string; pBest?: number; n?: number; reason?: 'stagnation' }>
}
export type JournalVariantRow = { variantId: string; label: string | null; createdAt: Date | string }
export type JournalEscalation = { title: string; createdAt: Date | string }

const utcDay = (d: Date | string): string => new Date(d).toISOString().slice(0, 10)

const JOURNAL_KIND_ORDER: Record<JournalEvent['kind'], number> = {
  variant_added: 0,
  variant_archived: 1,
  strategy_escalated: 2,
}

// Only days where the arm set changed (or an escalation was raised) produce an
// event — routine tick reweighting is internal state, not a decision to report.
export function buildJournal(
  decisions: JournalDecisionDay[],
  variants: JournalVariantRow[],
  escalations: JournalEscalation[],
  windowStartDay: string,
): JournalEvent[] {
  const labelById = new Map(variants.map((v) => [v.variantId, v.label]))
  const events: JournalEvent[] = []

  for (const day of decisions) {
    for (const a of day.archived) {
      events.push({
        date: day.cycleDate,
        kind: 'variant_archived',
        variantId: a.variantId,
        label: labelById.get(a.variantId) ?? null,
        reason: a.reason === 'stagnation' ? 'stagnation' : 'dominated',
        // Pre-Phase-C rows carry Wilson-era fields instead of pBest/n — read null-safe.
        pBest: typeof a.pBest === 'number' ? a.pBest : null,
        n: typeof a.n === 'number' ? a.n : null,
      })
    }
  }
  for (const v of variants) {
    const day = utcDay(v.createdAt)
    if (day >= windowStartDay) {
      events.push({ date: day, kind: 'variant_added', variantId: v.variantId, label: v.label })
    }
  }
  for (const e of escalations) {
    const day = utcDay(e.createdAt)
    if (day >= windowStartDay) {
      events.push({ date: day, kind: 'strategy_escalated', title: e.title })
    }
  }

  return events.sort((a, b) => {
    const byDate = a.date < b.date ? 1 : a.date > b.date ? -1 : 0
    if (byDate !== 0) return byDate
    const byKind = JOURNAL_KIND_ORDER[a.kind] - JOURNAL_KIND_ORDER[b.kind]
    if (byKind !== 0) return byKind
    const ak = a.kind !== 'strategy_escalated' ? a.variantId : a.title
    const bk = b.kind !== 'strategy_escalated' ? b.variantId : b.title
    return ak < bk ? -1 : ak > bk ? 1 : 0
  })
}

export type RejectionQuote = {
  freeText: string
  prospectName: string
  organizationName: string
}

export type DecisionMakerReferral = {
  prospectName: string
  organizationName: string
  name: string | null
  email: string | null
  role: string | null
}

export type NotRelevantNote = {
  freeText: string
  industry: string | null
  prospectName: string
  organizationName: string
}

export type DashboardRejections = {
  total: number
  topReasons: { reason: string; count: number; percentage: number }[]
  productSignal: { count: number; quotes: RejectionQuote[] } | null
  budgetSignal: { count: number; quotes: RejectionQuote[] } | null
  decisionMakers: DecisionMakerReferral[]
  notRelevant: NotRelevantNote[]
  recontactSoon: { window: RejectionRecontactWindow; count: number } | null
}

const SEGMENT_AXES = ['industry', 'employeeBand', 'country', 'discoveryStrategy'] as const
export type SegmentAxis = (typeof SEGMENT_AXES)[number]

export type SegmentRow = ReactionRates & { value: string; sent: number }
export type DashboardSegment = { axis: SegmentAxis; rows: SegmentRow[] }

// A glance, not a table: past the top few, near-identical rates read as noise.
const SEGMENT_ROWS_PER_AXIS = 3

export type ReactedCounts = { positive: number; interested: number }
export type SegmentCount = ReactedCounts & { axis: SegmentAxis; value: string | null; sent: number }

// Observational: the lever already orders sends by these axes, so a row is where
// reactions came from, not a controlled comparison.
export function buildSegments(counts: SegmentCount[], minSends: number): DashboardSegment[] {
  const byAxis: Record<SegmentAxis, Map<string, ReactedCounts & { sent: number }>> = {
    industry: new Map(),
    employeeBand: new Map(),
    country: new Map(),
    discoveryStrategy: new Map(),
  }
  for (const c of counts) {
    // 'unknown' is the employee_band default — a bucket nobody can act on.
    if (c.value === null || c.value === 'unknown') continue
    const value = c.axis === 'industry' ? coarseIndustry(c.value) : c.value
    // coarseIndustry folds every label outside the vocabulary into 'other', which
    // names no segment either.
    if (c.axis === 'industry' && value === 'other') continue
    const bucket = byAxis[c.axis]
    const held = bucket.get(value) ?? { sent: 0, positive: 0, interested: 0 }
    bucket.set(value, { sent: held.sent + c.sent, positive: held.positive + c.positive, interested: held.interested + c.interested })
  }
  return SEGMENT_AXES.flatMap((axis) => {
    const rows = Array.from(byAxis[axis], ([value, n]) => ({
      value,
      sent: n.sent,
      positiveRate: percentOf(n.positive, n.sent),
      interestedRate: percentOf(n.interested, n.sent),
    }))
      .filter((r) => r.sent >= minSends)
      .sort(
        (a, b) =>
          b.positiveRate - a.positiveRate ||
          b.interestedRate - a.interestedRate ||
          b.sent - a.sent ||
          (a.value < b.value ? -1 : 1),
      )
      .slice(0, SEGMENT_ROWS_PER_AXIS)
    // An axis needs two buckets over the floor to say anything: a single row has
    // nothing to be compared against, and with the rest of the sends below the
    // floor it sits close to the project's own rates anyway.
    return rows.length > 1 ? [{ axis, rows }] : []
  })
}

export type DashboardActivityKind =
  | 'sent'
  | 'failed'
  | 'skipped'
  | 'opened'
  | 'inquired'
  | 'replied'
  | 'meeting'
  | 'signup'
  | 'unsubscribed'

export type DashboardActivityEvent = {
  at: string
  prospectName: string
  organizationDomain: string
  channel: Channel
  kind: DashboardActivityKind
  detail: string | null
}


export type DashboardSummary = {
  period: DashboardPeriod
  kpis: {
    approached: KpiValue
    // Prospects with at least one send no bounce came back for.
    delivered: KpiValue
    reached: KpiValue
    engaged: KpiValue
    won: KpiValue
  }
  funnel: FunnelStage[]
  trend: DashboardTrendPoint[]
  // Prospects whose strongest reaction in the window was positive, and positive
  // or interest, as a percentage of those approached in it.
  reactionRates: { positive: RateChange; interested: RateChange }
  learning: DashboardLearning
  journal: JournalEvent[]
  // Newest lever-tick cycle date (all-time, not window-bound); null = no tick has ever run.
  lastCycleDate: string | null
  rejections: DashboardRejections
  segments: DashboardSegment[]
  recentActivity: DashboardActivityEvent[]
  attention: AttentionItem[]
}

const DAY_MS = 24 * 60 * 60 * 1000

export type WindowBounds = { curStart: Date; prevStart: Date }

// 'all' collapses both bounds to the epoch so the previous window is structurally
// empty (deltaPct null) with no special-casing in the SQL.
export function periodToWindow(period: DashboardPeriod, now: Date): WindowBounds {
  if (period === 'all') {
    const epoch = new Date(0)
    return { curStart: epoch, prevStart: epoch }
  }
  const days = period === '7d' ? 7 : 30
  return {
    curStart: new Date(now.getTime() - days * DAY_MS),
    prevStart: new Date(now.getTime() - 2 * days * DAY_MS),
  }
}

export function computeDeltaPct(current: number, previous: number): number | null {
  if (previous <= 0) return null
  return Math.round(((current - previous) / previous) * 100)
}

export function toKpi(current: number, previous: number): KpiValue {
  return { current, previous, deltaPct: computeDeltaPct(current, previous) }
}

// Capped at 100: a later stage can exceed the prior one (a reply needn't open the
// inquiry page; short windows lag attribution) and a ">100% conversion" reads as wrong.
function rate(count: number, prev: number): number | null {
  if (prev <= 0) return null
  return Math.min(100, Math.round((count / prev) * 100))
}

export type FunnelCounts = Record<FunnelStageKey, number>

// 'reached' is the inquiry-landing open. With the landing off the event cannot
// occur at all, so the stage is dropped rather than reported as a zero — and
// 'engaged' then converts from 'delivered'.
export function buildFunnel(counts: FunnelCounts, inquiryLandingEnabled: boolean): FunnelStage[] {
  const keys: FunnelStageKey[] = inquiryLandingEnabled
    ? ['sent', 'delivered', 'reached', 'engaged', 'won']
    : ['sent', 'delivered', 'engaged', 'won']
  return keys.map((key, i) => {
    const prev = keys[i - 1]
    return {
      key,
      count: counts[key],
      conversionFromPrev: prev === undefined ? null : rate(counts[key], counts[prev]),
    }
  })
}

export function percentOf(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

export type RateChange = { previous: number; current: number }

export type ProspectReaction = { prospectId: number; reaction: Reaction }

// A prospect counts once, by the strongest reaction any of its sends drew.
export function prospectLevels(rows: readonly ProspectReaction[]): Map<number, ReactionLevel> {
  const byProspect = new Map<number, Reaction[]>()
  for (const { prospectId, reaction } of rows) byProspect.set(prospectId, [...(byProspect.get(prospectId) ?? []), reaction])
  return new Map(Array.from(byProspect, ([prospectId, reactions]) => [prospectId, sendReaction(reactions).level]))
}

// `interested` counts the positive ones too.
export function levelCounts(levels: Iterable<ReactionLevel>): ReactedCounts {
  let positive = 0
  let interested = 0
  for (const level of levels) {
    if (level === 'positive') positive++
    if (level !== 'none') interested++
  }
  return { positive, interested }
}

export const TREND_DAYS = 30

// The SQL trend floor and buildTrend's zero-fill keys must share one clock, else a
// request near UTC midnight drops or zero-fills a boundary day. Both derive from this.
export function trendWindowStartIso(now: Date): string {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (TREND_DAYS - 1))
  return new Date(start).toISOString()
}

// Zero-fills the days the SQL omits. Day keys are UTC 'YYYY-MM-DD', matching the
// SQL bucket expression so the Map lookups hit.
export function buildTrend(
  now: Date,
  sent: { day: string; count: number }[],
  responses: { day: string; count: number }[],
): DashboardTrendPoint[] {
  const sentByDay = new Map(sent.map((r) => [r.day, r.count]))
  const respByDay = new Map(responses.map((r) => [r.day, r.count]))
  const out: DashboardTrendPoint[] = []
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i))
    const day = d.toISOString().slice(0, 10)
    out.push({ date: day, sent: sentByDay.get(day) ?? 0, responses: respByDay.get(day) ?? 0 })
  }
  return out
}
