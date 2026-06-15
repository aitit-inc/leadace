import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import { outreachLogs, projectDocuments, type Channel } from '../db/schema'
import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { ProjectRef, TenantId } from '../domain/ids'
import {
  DASHBOARD_PERIODS,
  buildFunnel,
  buildTrend,
  deriveAttentionItems,
  periodToWindow,
  replyRate,
  toKpi,
  trendWindowStartIso,
  type DashboardActivityKind,
  type DashboardLearning,
  type DashboardRejections,
  type DashboardSummary,
} from '../domain/dashboard'
import type { RejectionRecontactWindow } from '../db/schema'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { loadProjectOutboundAllowlist } from './project-settings'
import { getLeverStateById } from './levers'
import { listSubjectVariantsById } from './subject-variants'
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
    channelRateRows,
    pendingDraftsRows,
    emailTemplateRows,
    outboundAllowlist,
    leverRes,
    variantsRes,
    rejectionRes,
    recentRes,
    complianceRes,
    onboardingRes,
    gmailRes,
    planRes,
  ] = await Promise.all([
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
    // All-time channel reply rate (no maturity gate, unlike evaluations.ts); used only to rank
    // channels. DISTINCT keeps countable replies ≤ sends so the rate stays ≤ 100%.
    raw<{ channel: Channel; total: string | number; responses: string | number }>(sql`
      SELECT ol.channel AS channel,
        COUNT(DISTINCT ol.id)::int AS total,
        COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses
      FROM outreach_logs ol LEFT JOIN responses r ON r.outreach_log_id = ol.id
      WHERE ol.project_id = ${projectId} AND ol.status = 'sent'
      GROUP BY ol.channel`),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'pending_review'))),
    db
      .select({ slug: projectDocuments.slug })
      .from(projectDocuments)
      .where(and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.slug, 'email_template')))
      .limit(1),
    loadProjectOutboundAllowlist(db, projectId),
    getLeverStateById(db, tenantId, projectId),
    listSubjectVariantsById(db, tenantId, projectId),
    getRejectionFeedbackSummaryById(db, tenantId, projectId, {
      scope: 'all',
      freeTextLimit: 5,
      recontactLimit: 5,
      notRelevantLimit: 5,
      ...(windowDays !== undefined ? { windowDays } : {}),
    }),
    listRecentOutreachById(db, tenantId, projectId, { limit: RECENT_ACTIVITY_CANDIDATES, offset: 0 }),
    getTenantComplianceStatus(db, tenantId),
    getOnboardingStatus(db, tenantId),
    getCredentialsStatus(db, tenantId, userId),
    getPlanInfo(db, tenantId, edition),
  ])

  // One-by-one (not a loop) so each result narrows to its ok branch for the build below.
  if (!leverRes.ok) return leverRes
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

  const learning = buildLearning(leverRes.value, variantsRes.value.variants, channelRateRows)
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
    emailTemplateExists: emailTemplateRows.length > 0,
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
    rejections,
    recentActivity,
    attention,
  })
}

type LeverStateLike = Awaited<ReturnType<typeof getLeverStateById>> extends ServiceResult<infer T> ? T : never
type SubjectVariantLike = { variantId: string; subjectPattern: string; label: string | null }

function buildLearning(
  lever: LeverStateLike,
  variants: SubjectVariantLike[],
  channelRows: { channel: Channel; total: string | number; responses: string | number }[],
): DashboardLearning {
  const patternById = new Map(variants.map((v) => [v.variantId, v]))

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
        pattern: patternById.get(pick.variantId)?.subjectPattern ?? pick.variantId,
        replyRate: replyRate(pick.responses, pick.total),
        mature: pick.mature,
      }
    : null

  const channelOrder = channelRows
    .map((r) => ({ channel: r.channel, total: Number(r.total), responses: Number(r.responses) }))
    .filter((r) => r.total > 0)
    .map((r) => ({ channel: r.channel, rate: replyRate(r.responses, r.total) }))
    .sort((a, b) => b.rate - a.rate)

  const matureCount = lever.variants.filter((v) => v.mature).length
  return {
    bestSubject,
    channelOrder,
    testing: { activeVariants: lever.variants.length, needsNewAngle: lever.needsReplenishment },
    state: lever.weights && matureCount >= 2 ? 'optimizing' : 'learning',
  }
}

type RejectionSummaryLike = Awaited<ReturnType<typeof getRejectionFeedbackSummaryById>> extends ServiceResult<infer T>
  ? T
  : never

const RECONTACT_PRIORITY: RejectionRecontactWindow[] = ['3_months', '6_months', '12_months']

function buildRejections(rej: RejectionSummaryLike): DashboardRejections {
  const featureGap = rej.primaryReasonDistribution.find((r) => r.reason === 'feature_gap')
  let recontactSoon: DashboardRejections['recontactSoon'] = null
  for (const w of RECONTACT_PRIORITY) {
    const bucket = rej.recontactWindows[w]
    if (bucket && bucket.count > 0) {
      recontactSoon = { window: w, count: bucket.count }
      break
    }
  }
  return {
    total: rej.total,
    topReasons: rej.primaryReasonDistribution.slice(0, 5),
    productSignal: featureGap && featureGap.count > 0 ? { count: featureGap.count } : null,
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
