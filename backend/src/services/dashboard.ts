import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { outreachLogs, projectDocuments } from '../db/schema'
import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { ProjectRef, TenantId } from '../domain/ids'
import {
  DASHBOARD_PERIODS,
  JOURNAL_WINDOW_DAYS,
  buildFunnel,
  buildJournal,
  buildTrend,
  deriveAttentionItems,
  parseLearnings,
  periodToWindow,
  replyRate,
  toKpi,
  trendWindowStartIso,
  type DashboardActivityKind,
  type DashboardLearning,
  type DashboardRejections,
  type DashboardSummary,
  type DecisionMakerReferral,
  type LearningEntry,
  type NotRelevantNote,
  type RejectionQuote,
} from '../domain/dashboard'
import type { RejectionRecontactWindow } from '../db/schema'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadProjectOutboundAllowlist } from './project-settings'
import { getLeverDecisionsHistory, getLeverStateById } from './levers'
import { listMessageVariantsById, type MessageVariantRow } from './message-variants'
import { REVISIT_STRATEGY_SUGGESTION_KIND } from './suggestions'
import { getRejectionFeedbackSummaryById } from './responses'
import { listRecentOutreachById } from './outreach'
import { getTenantComplianceStatus, getOnboardingStatus } from './tenants'
import { getCredentialsStatus } from './google-auth'
import { getPlanInfo } from './billing'

export const dashboardQuerySchema = z.object({
  period: z.enum(DASHBOARD_PERIODS).default('30d'),
})
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>

const DAY_MS = 24 * 60 * 60 * 1000

// No per-lead seen/handled state exists, so this is "recent" rather than a true unread count.
const HOT_LEADS_WINDOW_DAYS = 7

const RECENT_ACTIVITY_LIMIT = 8
// listRecentOutreach orders by sent_at, but the feed sorts by event time (reply/visit/sent);
// over-fetch so a fresh reply/visit on an older send still surfaces, then slice after re-sort.
const RECENT_ACTIVITY_CANDIDATES = 50

type WindowCountRow = { current: string | number; previous: string | number }

// Through the prod transaction pooler (prepare:false) postgres-js can't read column type
// OIDs, so raw db.execute returns int/timestamp columns as strings — numeric reads below use
// Number(...) and timestamps bind as ISO strings with an explicit ::timestamptz cast.
export async function getDashboardSummary(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  projectRef: ProjectRef,
  query: DashboardQuery,
): Promise<ServiceResult<DashboardSummary>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const now = new Date()
  const { curStart, prevStart } = periodToWindow(query.period, now)
  const curIso = curStart.toISOString()
  const prevIso = prevStart.toISOString()
  const hotSinceIso = new Date(now.getTime() - HOT_LEADS_WINDOW_DAYS * DAY_MS).toISOString()
  const trendSinceIso = trendWindowStartIso(now)
  const windowDays = query.period === '7d' ? 7 : query.period === '30d' ? 30 : undefined

  const raw = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [
    approachedRows,
    reachedRows,
    engagedRows,
    wonRows,
    replyResponderRows,
    hotLeadsRows,
    dailySentRows,
    dailyResponseRows,
    lastCycleRows,
    escalationRows,
    pendingDraftsRows,
    learningsRows,
    outboundAllowlist,
    leverRes,
    leverHistoryRes,
    variantsRes,
    rejectionRes,
    recentRes,
    complianceRes,
    onboardingRes,
    gmailRes,
    planRes,
  ] = await Promise.all([
    // The four KPI stage queries below define the funnel-stage events. They MUST stay
    // in lockstep with funnelStageCondition in services/outreach.ts — the KPI drill-down
    // filter over the same events (pinned by e2e/regression-funnel-drilldown.sh).
    // approached = distinct prospects contacted in the window (matches the lower funnel stages' unit)
    raw<WindowCountRow>(sql`
      SELECT
        COUNT(DISTINCT prospect_id) FILTER (WHERE sent_at >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT prospect_id) FILTER (WHERE sent_at >= ${prevIso}::timestamptz AND sent_at < ${curIso}::timestamptz)::int AS previous
      FROM outreach_logs
      WHERE project_id = ${projectId} AND status = 'sent' AND sent_at >= ${prevIso}::timestamptz`),
    // reached = distinct prospects who opened their inquiry page (session start in window)
    raw<WindowCountRow>(sql`
      SELECT
        COUNT(DISTINCT s.prospect_id) FILTER (WHERE s.opened_at >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT s.prospect_id) FILTER (WHERE s.opened_at >= ${prevIso}::timestamptz AND s.opened_at < ${curIso}::timestamptz)::int AS previous
      FROM inquiry_sessions s JOIN outreach_logs ol ON ol.id = s.outreach_log_id
      WHERE ol.project_id = ${projectId} AND s.opened_at >= ${prevIso}::timestamptz`),
    // engaged = distinct prospects who replied (countable) OR chatted/beyond on the landing page
    raw<WindowCountRow>(sql`
      WITH ev AS (
        SELECT ol.prospect_id AS pid, r.received_at AS ts
        FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
        WHERE ol.project_id = ${projectId} AND r.response_type NOT IN ('bounce', 'auto_reply')
          AND r.received_at >= ${prevIso}::timestamptz
        UNION ALL
        SELECT s.prospect_id AS pid, s.opened_at AS ts
        FROM inquiry_sessions s JOIN outreach_logs ol ON ol.id = s.outreach_log_id
        WHERE ol.project_id = ${projectId} AND s.outcome IN ('inquired', 'lead', 'signup_clicked')
          AND s.opened_at >= ${prevIso}::timestamptz
      )
      SELECT
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${prevIso}::timestamptz AND ts < ${curIso}::timestamptz)::int AS previous
      FROM ev`),
    // won = distinct prospects who requested a meeting or clicked self-serve signup
    raw<WindowCountRow>(sql`
      WITH ev AS (
        SELECT ol.prospect_id AS pid, r.received_at AS ts
        FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
        WHERE ol.project_id = ${projectId} AND r.response_type = 'meeting_request'
          AND r.received_at >= ${prevIso}::timestamptz
        UNION ALL
        SELECT s.prospect_id AS pid, s.opened_at AS ts
        FROM inquiry_sessions s JOIN outreach_logs ol ON ol.id = s.outreach_log_id
        WHERE ol.project_id = ${projectId} AND s.outcome IN ('lead', 'signup_clicked')
          AND s.opened_at >= ${prevIso}::timestamptz
      )
      SELECT
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${prevIso}::timestamptz AND ts < ${curIso}::timestamptz)::int AS previous
      FROM ev`),
    // distinct prospects who replied (countable) in the window — numerator for "Reply rate" as a
    // % of approached prospects. DISTINCT + status='sent' mirrors the approached denominator's unit.
    raw<WindowCountRow>(sql`
      SELECT
        COUNT(DISTINCT ol.prospect_id) FILTER (WHERE r.received_at >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT ol.prospect_id) FILTER (WHERE r.received_at >= ${prevIso}::timestamptz AND r.received_at < ${curIso}::timestamptz)::int AS previous
      FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
      WHERE ol.project_id = ${projectId} AND ol.status = 'sent' AND r.response_type NOT IN ('bounce', 'auto_reply')
        AND r.received_at >= ${prevIso}::timestamptz`),
    // hot leads = distinct prospects who requested a meeting in the last 7 days (fixed).
    // Self-serve signups (signup_clicked) are excluded — this card routes to /responses
    // (the meeting/reply queue), where a signup wouldn't appear.
    raw<{ count: string | number }>(sql`
      WITH ev AS (
        SELECT ol.prospect_id AS pid
        FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
        WHERE ol.project_id = ${projectId} AND r.response_type = 'meeting_request'
          AND r.received_at >= ${hotSinceIso}::timestamptz
        UNION
        SELECT s.prospect_id AS pid
        FROM inquiry_sessions s JOIN outreach_logs ol ON ol.id = s.outreach_log_id
        WHERE ol.project_id = ${projectId} AND s.outcome = 'lead'
          AND s.opened_at >= ${hotSinceIso}::timestamptz
      )
      SELECT COUNT(DISTINCT pid)::int AS count FROM ev`),
    raw<{ day: string; count: string | number }>(sql`
      SELECT (sent_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
      FROM outreach_logs
      WHERE project_id = ${projectId} AND status = 'sent' AND sent_at >= ${trendSinceIso}::timestamptz
      GROUP BY day`),
    raw<{ day: string; count: string | number }>(sql`
      SELECT (r.received_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
      FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id
      WHERE ol.project_id = ${projectId} AND r.received_at >= ${trendSinceIso}::timestamptz
        AND r.response_type NOT IN ('bounce', 'auto_reply')
      GROUP BY day`),
    // ::text so a direct (non-pooler) connection can't hand back a Date.
    raw<{ last: string | null }>(sql`
      SELECT MAX(cycle_date)::text AS last FROM lever_decisions WHERE project_id = ${projectId}`),
    // Day-based cutoff matching the lever_decisions history window, so the
    // journal's first UTC day is complete instead of rolling-instant-truncated.
    raw<{ title: string; createdAt: string | Date }>(sql`
      SELECT title, created_at AS "createdAt" FROM suggestions
      WHERE project_id = ${projectId} AND kind = ${REVISIT_STRATEGY_SUGGESTION_KIND}
        AND (created_at AT TIME ZONE 'UTC') >= (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${JOURNAL_WINDOW_DAYS})`),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'pending_review'))),
    db
      .select({ content: projectDocuments.content })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.slug, 'learnings')))
      .orderBy(desc(projectDocuments.createdAt))
      .limit(1),
    loadProjectOutboundAllowlist(db, projectId),
    getLeverStateById(db, tenantId, projectId),
    getLeverDecisionsHistory(db, tenantId, projectId, JOURNAL_WINDOW_DAYS),
    listMessageVariantsById(db, tenantId, projectId),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      scope: 'all',
      freeTextLimit: 5,
      recontactLimit: 5,
      notRelevantLimit: 5,
      ...(windowDays !== undefined ? { windowDays } : {}),
    }),
    listRecentOutreachById(db, tenantId, projectId, { limit: RECENT_ACTIVITY_CANDIDATES, offset: 0, period: 'all' }),
    getTenantComplianceStatus(db, tenantId),
    getOnboardingStatus(db, tenantId),
    getCredentialsStatus(db, tenantId, userId),
    getPlanInfo(db, tenantId, edition),
  ])

  // One-by-one (not a loop) so each result narrows to its ok branch for the build below.
  if (!leverRes.ok) return leverRes
  if (!leverHistoryRes.ok) return leverHistoryRes
  if (!variantsRes.ok) return variantsRes
  if (!rejectionRes.ok) return rejectionRes
  if (!recentRes.ok) return recentRes
  if (!complianceRes.ok) return complianceRes
  if (!onboardingRes.ok) return onboardingRes
  if (!gmailRes.ok) return gmailRes
  if (!planRes.ok) return planRes

  const approached = toKpi(Number(approachedRows[0]?.current ?? 0), Number(approachedRows[0]?.previous ?? 0))
  const reached = toKpi(Number(reachedRows[0]?.current ?? 0), Number(reachedRows[0]?.previous ?? 0))
  const engaged = toKpi(Number(engagedRows[0]?.current ?? 0), Number(engagedRows[0]?.previous ?? 0))
  const won = toKpi(Number(wonRows[0]?.current ?? 0), Number(wonRows[0]?.previous ?? 0))

  const funnel = buildFunnel({
    sent: approached.current,
    reached: reached.current,
    engaged: engaged.current,
    won: won.current,
  })

  const trend = buildTrend(
    now,
    dailySentRows.map((r) => ({ day: r.day, count: Number(r.count) })),
    dailyResponseRows.map((r) => ({ day: r.day, count: Number(r.count) })),
  )

  const learning = buildLearning(
    leverRes.value,
    variantsRes.value.variants,
    parseLearnings(learningsRows[0]?.content ?? null),
  )
  const journal = buildJournal(
    leverHistoryRes.value.decisions,
    variantsRes.value.variants,
    escalationRows,
    new Date(now.getTime() - JOURNAL_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10),
  )
  const rejections = buildRejections(rejectionRes.value)
  const recentActivity = recentRes.value.logs
    .map(toActivityEvent)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECENT_ACTIVITY_LIMIT)

  const quota = planRes.value.outreach
  const attention = deriveAttentionItems({
    mcpConnected: onboardingRes.value.mcpConnected,
    compliance: { ready: complianceRes.value.ready, missing: complianceRes.value.missing },
    gmailConnected: gmailRes.value.connected,
    outboundChannelsConfigured: outboundAllowlist.outboundChannels.length > 0,
    quota: {
      exhausted: quota.kind === 'capped' && quota.remaining <= 0,
      constraint: quota.kind === 'capped' ? quota.bindingConstraint : null,
    },
    pendingDrafts: Number(pendingDraftsRows[0]?.count ?? 0),
    hotLeadsRecent: Number(hotLeadsRows[0]?.count ?? 0),
  })

  return ok({
    period: query.period,
    kpis: { approached, reached, engaged, won },
    funnel,
    trend,
    replyRateTrend: {
      // Cap at 100 like the funnel: replies lagged from earlier-window sends can exceed in-window approached.
      current: Math.min(100, replyRate(Number(replyResponderRows[0]?.current ?? 0), approached.current)),
      previous: Math.min(100, replyRate(Number(replyResponderRows[0]?.previous ?? 0), approached.previous)),
    },
    learning,
    journal,
    lastCycleDate: lastCycleRows[0]?.last ?? null,
    rejections,
    recentActivity,
    attention,
  })
}

type LeverStateLike = Awaited<ReturnType<typeof getLeverStateById>> extends ServiceResult<infer T> ? T : never

function buildLearning(
  lever: LeverStateLike,
  variants: MessageVariantRow[],
  log: LearningEntry[],
): DashboardLearning {
  const variantById = new Map(variants.map((v) => [v.variantId, v]))

  // Rank by bandit weight when present, else mature reply rate; skip 0-send arms (a 0-send "leader" is noise).
  const ranked = [...lever.variants].sort((a, b) => {
    if (lever.weights) return (b.weight ?? 0) - (a.weight ?? 0)
    const ra = a.total > 0 ? a.responses / a.total : 0
    const rb = b.total > 0 ? b.responses / b.total : 0
    return rb - ra
  })
  const pick = ranked.find((v) => v.total > 0) ?? null
  const bestSubject = pick
    ? {
        pattern: variantById.get(pick.variantId)?.subjectPattern ?? pick.variantId,
        replyRate: replyRate(pick.responses, pick.total),
        mature: pick.mature,
        n: pick.total,
      }
    : null

  const angles = ranked.map((v) => ({
    variantId: v.variantId,
    label: variantById.get(v.variantId)?.label ?? null,
    total: v.total,
    responses: v.responses,
    replyRate: replyRate(v.responses, v.total),
    mature: v.mature,
    leader: pick !== null && v.variantId === pick.variantId,
  }))

  const matureCount = lever.variants.filter((v) => v.mature).length
  return {
    bestSubject,
    angles,
    needsNewAngle: lever.needsReplenishment,
    state: lever.weights && matureCount >= 2 ? 'optimizing' : 'learning',
    log,
  }
}

type RejectionSummaryLike = Awaited<ReturnType<typeof getRejectionFeedbackSummaryById>> extends ServiceResult<infer T>
  ? T
  : never

const RECONTACT_PRIORITY: RejectionRecontactWindow[] = ['3_months', '6_months', '12_months']

const REJECTION_DETAIL_SHOWN = 3

function quotesFrom(
  notes: Array<{ freeText: string | null; prospectName: string; organizationName: string }>,
): RejectionQuote[] {
  return notes
    .map((n) => ({
      freeText: n.freeText?.trim() ?? '',
      prospectName: n.prospectName,
      organizationName: n.organizationName,
    }))
    .filter((q) => q.freeText.length > 0)
    .slice(0, REJECTION_DETAIL_SHOWN)
}

export function buildRejections(rej: RejectionSummaryLike): DashboardRejections {
  const featureGap = rej.primaryReasonDistribution.find((r) => r.reason === 'feature_gap')
  const budget = rej.primaryReasonDistribution.find((r) => r.reason === 'budget')
  let recontactSoon: DashboardRejections['recontactSoon'] = null
  for (const w of RECONTACT_PRIORITY) {
    const bucket = rej.recontactWindows[w]
    if (bucket && bucket.count > 0) {
      recontactSoon = { window: w, count: bucket.count }
      break
    }
  }

  const decisionMakers: DecisionMakerReferral[] = rej.decisionMakerPointers
    .map((p) => ({
      prospectName: p.prospectName,
      organizationName: p.organizationName,
      name: p.pointer?.name?.trim() || null,
      email: p.pointer?.email?.trim() || null,
      role: p.pointer?.role?.trim() || null,
    }))
    .filter((r) => r.name !== null || r.email !== null || r.role !== null)
    .slice(0, REJECTION_DETAIL_SHOWN)

  const notRelevant: NotRelevantNote[] = rej.notRelevantNotes
    .map((n) => ({
      freeText: n.freeText?.trim() ?? '',
      industry: n.industry?.trim() || null,
      prospectName: n.prospectName,
      organizationName: n.organizationName,
    }))
    .filter((n) => n.freeText.length > 0)
    .slice(0, REJECTION_DETAIL_SHOWN)

  return {
    total: rej.total,
    topReasons: rej.primaryReasonDistribution.slice(0, 5),
    productSignal:
      featureGap && featureGap.count > 0
        ? { count: featureGap.count, quotes: quotesFrom(rej.featureGapNotes) }
        : null,
    budgetSignal:
      budget && budget.count > 0 ? { count: budget.count, quotes: quotesFrom(rej.budgetNotes) } : null,
    decisionMakers,
    notRelevant,
    recontactSoon,
  }
}

type RecentLogLike = Awaited<ReturnType<typeof listRecentOutreachById>> extends ServiceResult<infer T>
  ? T extends { logs: Array<infer L> }
    ? L
    : never
  : never

function toActivityEvent(log: RecentLogLike): DashboardSummary['recentActivity'][number] {
  let kind: DashboardActivityKind
  if (log.inquiryOutcome === 'lead' || log.hasMeetingRequest) kind = 'meeting'
  else if (log.inquiryOutcome === 'signup_clicked') kind = 'signup'
  else if (log.inquiryOutcome === 'unsubscribed') kind = 'unsubscribed'
  else if (log.countableResponseCount > 0) kind = 'replied'
  else if (log.inquiryOutcome === 'inquired') kind = 'inquired'
  else if (log.inquiryOutcome === 'opened') kind = 'opened'
  else if (log.status === 'failed') kind = 'failed'
  else if (log.status === 'skipped') kind = 'skipped'
  else kind = 'sent'

  return {
    at: new Date(log.latestResponseAt ?? log.inquiryLastVisitAt ?? log.sentAt).toISOString(),
    prospectName: log.prospectName,
    organizationDomain: log.organizationDomain,
    channel: log.channel,
    kind,
    detail: kind === 'failed' ? log.errorMessage : null,
  }
}
