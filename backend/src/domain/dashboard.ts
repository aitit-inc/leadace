import type { Channel, RejectionRecontactWindow } from '../db/schema'

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

export type DashboardLearning = {
  bestSubject: { pattern: string; replyRate: number; mature: boolean } | null
  channelOrder: { channel: Channel; rate: number }[]
  testing: { activeVariants: number; needsNewAngle: boolean }
  state: 'learning' | 'optimizing'
}

export type DashboardRejections = {
  total: number
  topReasons: { reason: string; count: number; percentage: number }[]
  productSignal: { count: number } | null
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

export type QuotaConstraint = 'daily' | 'lifetime' | 'monthly'

export type AttentionItem =
  | { kind: 'mcp_not_connected' }
  | { kind: 'compliance_incomplete'; missing: string[] }
  | { kind: 'gmail_disconnected' }
  | { kind: 'no_outbound_channels' }
  | { kind: 'email_template_missing' }
  | { kind: 'quota_exhausted'; constraint: QuotaConstraint }
  | { kind: 'hot_leads'; count: number }
  | { kind: 'outreach_drafts'; count: number }

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

export type AttentionInput = {
  mcpConnected: boolean
  compliance: { ready: boolean; missing: string[] }
  gmailConnected: boolean
  outboundChannelsConfigured: boolean
  emailTemplateExists: boolean
  quota: { exhausted: boolean; constraint: QuotaConstraint | null }
  pendingDrafts: number
  hotLeadsRecent: number
}

// Push order is the display priority: opportunity (hot leads) → blockers → review queue.
export function deriveAttentionItems(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = []

  if (input.hotLeadsRecent > 0) items.push({ kind: 'hot_leads', count: input.hotLeadsRecent })
  if (!input.mcpConnected) items.push({ kind: 'mcp_not_connected' })
  if (!input.compliance.ready) {
    items.push({ kind: 'compliance_incomplete', missing: input.compliance.missing })
  }
  if (!input.gmailConnected) items.push({ kind: 'gmail_disconnected' })
  if (!input.outboundChannelsConfigured) items.push({ kind: 'no_outbound_channels' })
  if (!input.emailTemplateExists) items.push({ kind: 'email_template_missing' })
  if (input.quota.exhausted && input.quota.constraint) {
    items.push({ kind: 'quota_exhausted', constraint: input.quota.constraint })
  }
  if (input.pendingDrafts > 0) items.push({ kind: 'outreach_drafts', count: input.pendingDrafts })

  return items
}
