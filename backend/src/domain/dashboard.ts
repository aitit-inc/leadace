import type { Channel, RejectionRecontactWindow } from '../db/schema'
import type { AttentionItem } from './attention'

export const DASHBOARD_PERIODS = ['7d', '30d', 'all'] as const
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number]

export type KpiValue = {
  current: number
  previous: number
  deltaPct: number | null
}

export type FunnelStageKey = 'sent' | 'reached' | 'engaged' | 'won'

export type FunnelStage = {
  key: FunnelStageKey
  count: number
  conversionFromPrev: number | null
}

export type DashboardTrendPoint = { date: string; sent: number; responses: number }

// Stage tags /evaluate writes into the Learnings Log, one per downstream decision a
// skill acts on. '[retired]' is a tombstone, not a stage — readers (and parseLearnings) skip it.
export const LEARNING_STAGES = ['targeting', 'body', 'timing', 'channel', 'discovery'] as const
export type LearningStage = (typeof LEARNING_STAGES)[number]

export type LearningEntry = { stage: LearningStage; date: string; claim: string; evidence: string | null }

export type LearningAngle = {
  variantId: string
  label: string | null
  total: number
  responses: number
  replyRate: number
  mature: boolean
  leader: boolean
}

export type DashboardLearning = {
  bestSubject: { pattern: string; replyRate: number; mature: boolean; n: number } | null
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
    reached: KpiValue
    engaged: KpiValue
    won: KpiValue
  }
  funnel: FunnelStage[]
  trend: DashboardTrendPoint[]
  replyRateTrend: { previous: number; current: number }
  learning: DashboardLearning
  journal: JournalEvent[]
  // Newest lever-tick cycle date (all-time, not window-bound); null = no tick has ever run.
  lastCycleDate: string | null
  rejections: DashboardRejections
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

export function buildFunnel(counts: {
  sent: number
  reached: number
  engaged: number
  won: number
}): FunnelStage[] {
  return [
    { key: 'sent', count: counts.sent, conversionFromPrev: null },
    { key: 'reached', count: counts.reached, conversionFromPrev: rate(counts.reached, counts.sent) },
    { key: 'engaged', count: counts.engaged, conversionFromPrev: rate(counts.engaged, counts.reached) },
    { key: 'won', count: counts.won, conversionFromPrev: rate(counts.won, counts.engaged) },
  ]
}

export function replyRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

const LEARNING_STAGE_SET = new Set<string>(LEARNING_STAGES)
// Each entry: "[stage] [YYYY-MM-DD] claim — evidence: metric=…, n=…". Tolerant of a
// leading markdown bullet since the doc is LLM-authored; the evidence tail is trimmed
// for the glance card. Unrecognized lines (headers, '[retired]' tombstones) are dropped.
const LEARNING_LINE = /^\[([a-z_]+)\]\s*\[(\d{4}-\d{2}-\d{2})\]\s*(.+)$/i

export function parseLearnings(content: string | null): LearningEntry[] {
  if (!content) return []
  const out: LearningEntry[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '')
    const m = LEARNING_LINE.exec(line)
    if (!m) continue
    const stage = m[1]!.toLowerCase()
    if (!LEARNING_STAGE_SET.has(stage)) continue
    const rest = m[3]!.trim()
    const [claimPart, ...evidenceParts] = rest.split(/\s*[—–-]+\s*evidence:\s*/i)
    const claim = claimPart!.trim()
    const evidence = evidenceParts.join(' ').trim() || null
    out.push({ stage: stage as LearningStage, date: m[2]!, claim: claim || rest, evidence })
  }
  // Newest first: the doc's line order is LLM-authored and undefined, but the glance card
  // truncates to the top few — surface the most recent learnings deterministically.
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
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

