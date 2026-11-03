import type { Channel, RejectionRecontactWindow } from '../db/schema'
import type { AttentionItem } from './attention'
import { coarseIndustry } from './coarse-industry'
import type { HistoryRow } from './history'
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


// The companies discovery registered in the window. `notFit` failed the fit
// check or could not be confirmed; `noContact` fit but publish no channel.
export type DashboardResearch = {
  researched: number
  notFit: number
  notFitPercent: number
  noContact: number
  notFitExamples: Array<{ organizationName: string; reason: string }>
}

type RespondedLevel = Exclude<ReactionLevel, 'none'>
export type DashboardResponder = { prospectName: string; organizationName: string; level: RespondedLevel }

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
  history: HistoryRow[]
  // Newest lever-tick cycle date (all-time, not window-bound); null = no tick has ever run.
  lastCycleDate: string | null
  rejections: DashboardRejections
  segments: DashboardSegment[]
  research: DashboardResearch
  responders: DashboardResponder[]
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

// 'reached' is the inquiry-landing open. With the landing off only links already
// sent can still be opened, so the stage shows only when one was — never as a
// zero that cannot fill — and otherwise 'engaged' converts from 'delivered'.
export function buildFunnel(counts: FunnelCounts, inquiryLandingEnabled: boolean): FunnelStage[] {
  const keys: FunnelStageKey[] = inquiryLandingEnabled || counts.reached > 0
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

// Strongest reaction first, then the latest.
export function latestResponders(
  rows: ReadonlyArray<ProspectReaction & { at: Date }>,
  limit: number,
): Array<{ prospectId: number; level: RespondedLevel }> {
  const latest = new Map<number, number>()
  for (const { prospectId, at } of rows) latest.set(prospectId, Math.max(latest.get(prospectId) ?? 0, at.getTime()))
  return [...prospectLevels(rows)]
    .flatMap(([prospectId, level]) => (level === 'none' ? [] : [{ prospectId, level, at: latest.get(prospectId) ?? 0 }]))
    .sort((a, b) => (a.level === b.level ? b.at - a.at : a.level === 'positive' ? -1 : 1))
    .slice(0, limit)
    .map(({ prospectId, level }) => ({ prospectId, level }))
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
