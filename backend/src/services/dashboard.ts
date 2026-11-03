import { z } from 'zod'
import { and, count, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm'
import {
  inquirySessions,
  organizations,
  outreachLogs,
  projectProspects,
  projectSettings,
  prospects,
  responses,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { ProjectRef, TenantId } from '../domain/ids'
import {
  DASHBOARD_PERIODS,
  buildFunnel,
  buildSegments,
  buildTrend,
  latestResponders,
  levelCounts,
  percentOf,
  periodToWindow,
  prospectLevels,
  toKpi,
  trendWindowStartIso,
  type DashboardActivityKind,
  type DashboardRejections,
  type DashboardSummary,
  type ProspectReaction,
  type SegmentCount,
  type DecisionMakerReferral,
  type NotRelevantNote,
  type RejectionQuote,
} from '../domain/dashboard'
import { NON_COUNTABLE_RESPONSE_TYPES, REWARDED_INQUIRY_OUTCOMES } from '../domain/loop/reaction'
import { primaryReasonOf } from '../domain/rejection-feedback'
import type { RejectionRecontactWindow } from '../db/schema'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadLeverConfig } from './project-settings'
import { getHistoryById } from './loop/history'
import { HISTORY_WINDOW_DAYS } from '../domain/history'
import { getRejectionFeedbackSummaryById } from './responses'
import { projectTargetExpr } from './prospects'
import { listRecentOutreachById } from './outreach'
import { listProjectAttention } from './attention'

export const dashboardQuerySchema = z.object({
  period: z.enum(DASHBOARD_PERIODS).default('30d'),
})
export type DashboardQuery = z.infer<typeof dashboardQuerySchema>


const RECENT_ACTIVITY_LIMIT = 8
const NOT_FIT_EXAMPLES = 3
const RESPONDERS_SHOWN = 5
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
  const trendSinceIso = trendWindowStartIso(now)
  const windowDays = query.period === '7d' ? 7 : query.period === '30d' ? 30 : undefined

  const foundInWindow = and(eq(projectProspects.projectId, projectId), eq(prospects.origin, 'found'), gte(projectProspects.createdAt, curStart))

  const raw = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [
    approachedRows,
    deliveredRows,
    inquiryLandingRows,
    reachedRows,
    engagedRows,
    wonRows,
    replyRows,
    sessionRows,
    dailySentRows,
    dailyResponseRows,
    lastCycleRows,
    contactedRows,
    historyRes,
    rejectionRes,
    recentRes,
    attentionRes,
    leverConfig,
    researchRows,
    notFitExamples,
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
    // delivered = distinct prospects with a send no bounce came back for. Absence of a
    // bounce is not proof of delivery: a bounce binds only to a send whose Message-ID we
    // generated (services/reply-ingest.ts), so this is an upper bound.
    raw<WindowCountRow>(sql`
      WITH s AS (
        SELECT ol.prospect_id AS pid, ol.sent_at AS ts
        FROM outreach_logs ol
        WHERE ol.project_id = ${projectId} AND ol.status = 'sent'
          AND ol.sent_at >= ${prevIso}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM responses r
            WHERE r.outreach_log_id = ol.id AND r.response_type = 'bounce')
      )
      SELECT
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${curIso}::timestamptz)::int AS current,
        COUNT(DISTINCT pid) FILTER (WHERE ts >= ${prevIso}::timestamptz AND ts < ${curIso}::timestamptz)::int AS previous
      FROM s`),
    db
      .select({ enabled: projectSettings.inquiryLandingEnabled })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1),
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
    // Every reaction to the project's sends and when it came: the rates count
    // the window's, a segment a contacted prospect's whenever it came.
    db
      .select({
        prospectId: outreachLogs.prospectId,
        at: responses.receivedAt,
        responseType: responses.responseType,
        sentiment: responses.sentiment,
        reason: sql<string | null>`${responses.rejectionFeedback}->>'primary_reason'`,
      })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(
        eq(outreachLogs.projectId, projectId),
        eq(outreachLogs.status, 'sent'),
        notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES]),
      )),
    db
      .select({ prospectId: outreachLogs.prospectId, at: inquirySessions.openedAt, outcome: inquirySessions.outcome })
      .from(inquirySessions)
      .innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
      .where(and(
        eq(outreachLogs.projectId, projectId),
        eq(outreachLogs.status, 'sent'),
        inArray(inquirySessions.outcome, [...REWARDED_INQUIRY_OUTCOMES]),
      )),
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
    // Segments are on the rates' unit: prospects contacted in the window, counted once.
    db
      .selectDistinct({
        prospectId: prospects.id,
        industry: prospects.industry,
        employeeBand: organizations.employeeBand,
        prospectCountry: prospects.country,
        organizationCountry: organizations.country,
        strategy: prospects.discoveryStrategy,
      })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'sent'), gte(outreachLogs.sentAt, curStart))),
    getHistoryById(db, tenantId, projectId, HISTORY_WINDOW_DAYS, now),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      scope: 'all',
      freeTextLimit: 5,
      recontactLimit: 5,
      notRelevantLimit: 5,
      ...(windowDays !== undefined ? { windowDays } : {}),
    }),
    listRecentOutreachById(db, tenantId, projectId, { limit: RECENT_ACTIVITY_CANDIDATES, offset: 0, period: 'all' }),
    listProjectAttention(db, tenantId, userId, edition, projectId),
    loadLeverConfig(db, projectId),
    db
      .select({
        researched: count(),
        notFit: count(sql`CASE WHEN NOT ${projectProspects.qualified} THEN 1 END`),
        noContact: count(sql`CASE WHEN ${projectProspects.qualified} AND NOT (${projectTargetExpr}) THEN 1 END`),
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .where(foundInWindow),
    db
      .select({ organizationName: organizations.name, reason: projectProspects.matchReason })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(and(foundInWindow, eq(projectProspects.qualified, false)))
      .orderBy(desc(projectProspects.createdAt))
      .limit(NOT_FIT_EXAMPLES),
  ])

  // One-by-one (not a loop) so each result narrows to its ok branch for the build below.
  if (!historyRes.ok) return historyRes
  if (!rejectionRes.ok) return rejectionRes
  if (!recentRes.ok) return recentRes
  if (!attentionRes.ok) return attentionRes

  const approached = toKpi(Number(approachedRows[0]?.current ?? 0), Number(approachedRows[0]?.previous ?? 0))
  const delivered = toKpi(Number(deliveredRows[0]?.current ?? 0), Number(deliveredRows[0]?.previous ?? 0))
  const reached = toKpi(Number(reachedRows[0]?.current ?? 0), Number(reachedRows[0]?.previous ?? 0))
  const engaged = toKpi(Number(engagedRows[0]?.current ?? 0), Number(engagedRows[0]?.previous ?? 0))
  const won = toKpi(Number(wonRows[0]?.current ?? 0), Number(wonRows[0]?.previous ?? 0))

  const funnel = buildFunnel(
    {
      sent: approached.current,
      delivered: delivered.current,
      reached: reached.current,
      engaged: engaged.current,
      won: won.current,
    },
    inquiryLandingRows[0]?.enabled ?? false,
  )

  const trend = buildTrend(
    now,
    dailySentRows.map((r) => ({ day: r.day, count: Number(r.count) })),
    dailyResponseRows.map((r) => ({ day: r.day, count: Number(r.count) })),
  )

  const rejections = buildRejections(rejectionRes.value)

  const reactions: Array<ProspectReaction & { at: Date }> = [
    ...replyRows.map(({ prospectId, at, responseType, sentiment, reason }) => ({
      prospectId,
      at,
      reaction: { kind: 'reply' as const, responseType, sentiment, reason: primaryReasonOf(reason) },
    })),
    ...sessionRows.map(({ prospectId, at, outcome }) => ({ prospectId, at, reaction: { kind: 'inquiry' as const, outcome } })),
  ]
  const reactedIn = (from: Date, before?: Date) =>
    levelCounts(prospectLevels(reactions.filter((r) => r.at >= from && (before === undefined || r.at < before))).values())
  const reactedNow = reactedIn(curStart)
  const reactedBefore = reactedIn(prevStart, curStart)
  // Capped at 100 like the funnel: reactions to earlier-window sends can exceed in-window approached.
  const rateChange = (current: number, previous: number) => ({
    current: Math.min(100, percentOf(current, approached.current)),
    previous: Math.min(100, percentOf(previous, approached.previous)),
  })

  const levels = prospectLevels(reactions)
  const segments = buildSegments(
    contactedRows.flatMap((p): SegmentCount[] => {
      const counted = { sent: 1, ...levelCounts([levels.get(p.prospectId) ?? 'none']) }
      return [
        { axis: 'industry', value: p.industry?.trim() || null, ...counted },
        { axis: 'employeeBand', value: p.employeeBand, ...counted },
        { axis: 'country', value: p.prospectCountry ?? p.organizationCountry, ...counted },
        { axis: 'discoveryStrategy', value: p.strategy, ...counted },
      ]
    }),
    leverConfig.minSamplePerArm,
  )
  const named = latestResponders(reactions.filter((r) => r.at >= curStart), RESPONDERS_SHOWN)
  const names = named.length === 0
    ? []
    : await db
        .select({ prospectId: prospects.id, prospectName: prospects.name, organizationName: organizations.name })
        .from(prospects)
        .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
        .where(inArray(prospects.id, named.map((n) => n.prospectId)))
  const nameOf = new Map(names.map((n) => [n.prospectId, n]))
  const responders = named.flatMap(({ prospectId, level }) => {
    const name = nameOf.get(prospectId)
    return name ? [{ prospectName: name.prospectName, organizationName: name.organizationName, level }] : []
  })
  const recentActivity = recentRes.value.logs
    .map(toActivityEvent)
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, RECENT_ACTIVITY_LIMIT)

  return ok({
    period: query.period,
    kpis: { approached, delivered, reached, engaged, won },
    funnel,
    trend,
    reactionRates: {
      positive: rateChange(reactedNow.positive, reactedBefore.positive),
      interested: rateChange(reactedNow.interested, reactedBefore.interested),
    },
    history: historyRes.value,
    lastCycleDate: lastCycleRows[0]?.last ?? null,
    rejections,
    segments,
    research: {
      researched: researchRows[0]?.researched ?? 0,
      notFit: researchRows[0]?.notFit ?? 0,
      notFitPercent: percentOf(researchRows[0]?.notFit ?? 0, researchRows[0]?.researched ?? 0),
      noContact: researchRows[0]?.noContact ?? 0,
      notFitExamples,
    },
    responders,
    recentActivity,
    attention: attentionRes.value,
  })
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
