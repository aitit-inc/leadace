import { sql } from 'drizzle-orm'
import {
  INQUIRY_OUTCOMES,
  responseTypeEnum,
  sentimentEnum,
  type Channel,
  type EmployeeBand,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutreachStatus,
  type ProspectStatus,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import { replyReward } from '../domain/reward'
import { coarseIndustry, type CoarseIndustry } from '../domain/coarse-industry'
import { type LeverConfig } from '../domain/lever-config'
import type { TargetingAxisStat } from '../domain/targeting-score'
import type { VariantStat } from '../domain/message-bandit'
import type { ChannelFineStat } from '../domain/channel-affinity'
import { loadLeverConfig } from './project-settings'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'

// Through the prod transaction pooler (Supavisor, prepare:false) postgres-js
// can't read column type OIDs, so raw db.execute returns numeric/timestamp
// columns as strings (a direct connection parses them to number/Date). Row
// types below are honest about that (`string | number`) and reads normalize
// with Number(...); the bandit relies on it (wilsonBounds compares responses ≤
// total — a string compare would lie).

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

export type DailyActivity = { date: string; sent: number; responses: number }

export type RespondedMessage = {
  id: number
  channel: Channel
  subject: string | null
  body: string
  sentiment: Sentiment
  responseType: ResponseType
}

export type NoResponseMessage = {
  id: number
  channel: Channel
  subject: string | null
  body: string
}

export type ProjectStatsResult = {
  metrics: EvaluationMetrics
  respondedMessages: RespondedMessage[]
  noResponseSample: NoResponseMessage[]
  dataSufficiency: {
    sufficient: boolean
    totalSent: number
    daysSinceLastSend: number | null
  }
  dailyActivity: DailyActivity[]
}

// `responses` is COUNT(DISTINCT replied send) so it stays ≤
// total even when one send draws two countable replies — else responses>total
// throws in wilsonBounds. `rewardSum` deliberately sums over every countable
// reply row (graded reward per reply event). `NOT IN ('bounce','auto_reply')`
// mirrors NON_COUNTABLE in domain/reward.ts — keep the two in sync.
export async function getVariantStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
  // Tick path passes true so a forgetting window (if configured) narrows the bandit's
  // view to recent data; the all-history display path (getProjectStats) leaves it false.
  applyLookback = false,
): Promise<VariantStat[]> {
  const SENT: OutreachStatus = 'sent'
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`
  // Two lookback variants because the denom query uses bare `sent_at`
  // while the response/reward queries alias it `ol.sent_at`.
  const lookbackDays =
    applyLookback && config.rewardLookbackDays !== undefined
      ? config.rewardWindowDays + config.rewardLookbackDays
      : undefined
  const forgetBare = lookbackDays === undefined ? sql`` : sql` AND sent_at >= now() - make_interval(days => ${lookbackDays})`
  const forgetOl = lookbackDays === undefined ? sql`` : sql` AND ol.sent_at >= now() - make_interval(days => ${lookbackDays})`
  const epoch = applyLookback ? config.measurementsSince : undefined
  // The epoch is a UTC date; a bare `>= date` comparison would promote it at
  // the DB session TimeZone (same reason loadPriorDayRegistrations pins UTC).
  const epochBare = epoch === undefined ? sql`` : sql` AND sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const epochOl = epoch === undefined ? sql`` : sql` AND ol.sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const exec = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [denomRows, responseRows, rewardRows] = await Promise.all([
    exec<{ variantId: string; total: string | number }>(sql`SELECT variant_id AS "variantId", COUNT(*)::int AS total
             FROM outreach_logs
             WHERE project_id = ${projectId} AND status = ${SENT}
               AND variant_id IS NOT NULL AND sent_at < ${matureBefore}${forgetBare}${epochBare}
             GROUP BY variant_id ORDER BY variant_id`),
    exec<{ variantId: string; responses: string | number }>(sql`SELECT ol.variant_id AS "variantId", COUNT(DISTINCT ol.id)::int AS responses
             FROM outreach_logs ol JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.variant_id IS NOT NULL AND ol.sent_at < ${matureBefore}${forgetOl}${epochOl}
               AND r.response_type NOT IN ('bounce', 'auto_reply')
             GROUP BY ol.variant_id`),
    exec<{ variantId: string; responseType: ResponseType; sentiment: Sentiment; count: string | number }>(sql`SELECT ol.variant_id AS "variantId", r.response_type AS "responseType", r.sentiment, COUNT(*)::int AS count
             FROM outreach_logs ol JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.variant_id IS NOT NULL AND ol.sent_at < ${matureBefore}${forgetOl}${epochOl}
               AND r.response_type NOT IN ('bounce', 'auto_reply')
             GROUP BY ol.variant_id, r.response_type, r.sentiment`),
  ])

  const agg = new Map<string, VariantStat>()
  for (const row of denomRows) {
    agg.set(row.variantId, { variantId: row.variantId, total: Number(row.total), responses: 0, rewardSum: 0 })
  }
  for (const row of responseRows) {
    const entry = agg.get(row.variantId)
    if (!entry) continue
    entry.responses = Number(row.responses)
  }
  for (const row of rewardRows) {
    const entry = agg.get(row.variantId)
    if (!entry) continue
    entry.rewardSum +=
      replyReward({ responseType: row.responseType, sentiment: row.sentiment }, config.reward) *
      Number(row.count)
  }
  return Array.from(agg.values())
}

// COUNT(DISTINCT replied send) keeps responses ≤ total (two replies to one send
// would otherwise overflow the rate and throw in wilsonBounds). `NOT IN
// ('bounce','auto_reply')` mirrors NON_COUNTABLE in domain/reward.ts.
export async function getChannelStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
): Promise<ChannelFineStat[]> {
  const SENT: OutreachStatus = 'sent'
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`
  // Tick-path only — the epoch always applies so channel affinity re-baselines
  // with the other lever aggregates.
  const epoch = config.measurementsSince
  const since = epoch === undefined ? sql`` : sql` AND ol.sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const exec = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [denomRows, responseRows] = await Promise.all([
    exec<{ channel: Channel; industry: string | null; total: string | number }>(sql`SELECT ol.channel AS "channel", p.industry AS "industry", COUNT(*)::int AS total
             FROM outreach_logs ol JOIN prospects p ON p.id = ol.prospect_id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.sent_at < ${matureBefore}${since}
             GROUP BY ol.channel, p.industry`),
    exec<{ channel: Channel; industry: string | null; responses: string | number }>(sql`SELECT ol.channel AS "channel", p.industry AS "industry", COUNT(DISTINCT ol.id)::int AS responses
             FROM outreach_logs ol
               JOIN prospects p ON p.id = ol.prospect_id
               JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.sent_at < ${matureBefore}${since}
               AND r.response_type NOT IN ('bounce', 'auto_reply')
             GROUP BY ol.channel, p.industry`),
  ])

  const keyOf = (channel: string, industry: string | null): string => `${channel} ${industry ?? ''}`
  const agg = new Map<string, ChannelFineStat>()
  for (const row of denomRows) {
    const industry = row.industry ?? null
    agg.set(keyOf(row.channel, industry), { channel: row.channel, industry, total: Number(row.total), responses: 0 })
  }
  for (const row of responseRows) {
    const industry = row.industry ?? null
    const entry = agg.get(keyOf(row.channel, industry))
    if (!entry) continue
    entry.responses = Number(row.responses)
  }
  return Array.from(agg.values())
}

export type TargetingStats = {
  industry: TargetingAxisStat[] // coarse-folded
  employeeBand: TargetingAxisStat[]
  country: TargetingAxisStat[]
  discoveryStrategy: TargetingAxisStat[]
  freshSignal: { withSignal: TargetingAxisStat; withoutSignal: TargetingAxisStat }
}

// Bounced sends are excluded from denominator AND rewards: for targeting a
// bounce is source data-quality, not segment disinterest. (The message bandit
// keeps them — variant and bounce are uncorrelated there.)
export async function getTargetingStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
  applyLookback = false,
): Promise<TargetingStats> {
  const SENT: OutreachStatus = 'sent'
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`
  const lookbackDays =
    applyLookback && config.rewardLookbackDays !== undefined
      ? config.rewardWindowDays + config.rewardLookbackDays
      : undefined
  const forget = lookbackDays === undefined ? sql`` : sql` AND ol.sent_at >= now() - make_interval(days => ${lookbackDays})`
  const epoch = applyLookback ? config.measurementsSince : undefined
  const since = epoch === undefined ? sql`` : sql` AND ol.sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const exec = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const notBounced = sql`NOT EXISTS (SELECT 1 FROM responses rb WHERE rb.outreach_log_id = ol.id AND rb.response_type = 'bounce')`

  const axisStats = async (axisExpr: ReturnType<typeof sql>): Promise<TargetingAxisStat[]> => {
    const [denomRows, rewardRows] = await Promise.all([
      exec<{ value: string | null; total: string | number }>(sql`SELECT ${axisExpr} AS value, COUNT(*)::int AS total
               FROM outreach_logs ol
                 JOIN prospects p ON p.id = ol.prospect_id
                 JOIN organizations o ON o.id = p.organization_id
               WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                 AND ol.sent_at < ${matureBefore}${forget}${since} AND ${notBounced}
               GROUP BY 1`),
      exec<{ value: string | null; responseType: ResponseType; sentiment: Sentiment; count: string | number }>(sql`SELECT ${axisExpr} AS value, r.response_type AS "responseType", r.sentiment, COUNT(*)::int AS count
               FROM outreach_logs ol
                 JOIN prospects p ON p.id = ol.prospect_id
                 JOIN organizations o ON o.id = p.organization_id
                 JOIN responses r ON r.outreach_log_id = ol.id
               WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                 AND ol.sent_at < ${matureBefore}${forget}${since} AND ${notBounced}
                 AND r.response_type NOT IN ('bounce', 'auto_reply')
               GROUP BY 1, r.response_type, r.sentiment`),
    ])
    const keyOf = (v: string | null): string => (v === null ? '<null>' : `v:${v}`)
    const agg = new Map<string, TargetingAxisStat>()
    for (const row of denomRows) {
      agg.set(keyOf(row.value), { value: row.value, total: Number(row.total), rewardSum: 0 })
    }
    for (const row of rewardRows) {
      const entry = agg.get(keyOf(row.value))
      if (!entry) continue
      entry.rewardSum +=
        replyReward({ responseType: row.responseType, sentiment: row.sentiment }, config.reward) *
        Number(row.count)
    }
    return Array.from(agg.values()).sort((a, b) => {
      if (a.value === null) return b.value === null ? 0 : 1
      if (b.value === null) return -1
      return a.value.localeCompare(b.value)
    })
  }

  const [industryFine, employeeBand, country, discoveryStrategy, freshSignalRaw] = await Promise.all([
    axisStats(sql`NULLIF(TRIM(p.industry), '')`),
    axisStats(sql`o.employee_band::text`),
    axisStats(sql`UPPER(COALESCE(p.country, o.country))`),
    axisStats(sql`p.discovery_strategy`),
    axisStats(sql`CASE WHEN ol.had_fresh_signal THEN 'with' ELSE 'without' END`),
  ])

  const coarseAgg = new Map<CoarseIndustry, TargetingAxisStat>()
  for (const stat of industryFine) {
    const bucket = coarseIndustry(stat.value)
    const entry = coarseAgg.get(bucket) ?? { value: bucket, total: 0, rewardSum: 0 }
    entry.total += stat.total
    entry.rewardSum += stat.rewardSum
    coarseAgg.set(bucket, entry)
  }

  const EMPTY_STAT = (value: string): TargetingAxisStat => ({ value, total: 0, rewardSum: 0 })
  return {
    industry: Array.from(coarseAgg.values()).sort((a, b) => (a.value ?? '').localeCompare(b.value ?? '')),
    employeeBand,
    country,
    discoveryStrategy,
    freshSignal: {
      withSignal: freshSignalRaw.find((s) => s.value === 'with') ?? EMPTY_STAT('with'),
      withoutSignal: freshSignalRaw.find((s) => s.value === 'without') ?? EMPTY_STAT('without'),
    },
  }
}

// No forgetting window — futility judges the whole current regime, so only
// measurementsSince narrows it. `replies` counts replied sends (not reply
// rows) so it stays ≤ sends for the Beta posterior.
export async function getFutilityStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
): Promise<{ sends: number; replies: number }> {
  const SENT: OutreachStatus = 'sent'
  const EMAIL: Channel = 'email'
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`
  const epoch = config.measurementsSince
  const since = epoch === undefined ? sql`` : sql` AND ol.sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const rows = Array.from(
    await db.execute<{ sends: string | number; replies: string | number }>(sql`
      SELECT
        COUNT(*)::int AS sends,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM responses r WHERE r.outreach_log_id = ol.id
            AND r.response_type NOT IN ('bounce', 'auto_reply')
        ))::int AS replies
      FROM outreach_logs ol
      WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} AND ol.channel = ${EMAIL}
        AND ol.sent_at < ${matureBefore}${since}
        AND NOT EXISTS (SELECT 1 FROM responses rb WHERE rb.outreach_log_id = ol.id AND rb.response_type = 'bounce')
    `),
  )
  return { sends: Number(rows[0]?.sends ?? 0), replies: Number(rows[0]?.replies ?? 0) }
}

export async function getProjectStats(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<ProjectStatsResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const rawQuery = async <T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(query)) as T[]

  // Bind enum literals as parameters so a typo would surface at compile time.
  const SENT: OutreachStatus = 'sent'
  const FAILED: OutreachStatus = 'failed'
  // Lower bound for the activity-trend window: midnight UTC 29 days ago, so the
  // UTC-date buckets number exactly 30 (today + the previous 29) instead of a
  // rolling timestamp that can straddle 31 distinct UTC dates.
  const trendSince = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days') AT TIME ZONE 'UTC'`

  const config = await loadLeverConfig(db, projectId)
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`

  const [
    totalOutreachRows,
    channelCountsRows,
    responseCountsRows,
    sentimentBreakdownRows,
    priorityResponseRateRows,
    statusCountsRows,
    channelResponseRateRows,
    channelByIndustryRows,
    discoveryStrategyRows,
    industryRows,
    sizeRows,
    countryRows,
    freshSignalRows,
    respondedMessagesRows,
    noResponseSampleRows,
    lastSentRows,
    inquiryOutcomeRows,
    dailySentRows,
    dailyResponseRows,
    variantMetaRows,
  ] = await Promise.all([
    rawQuery<{ totalOutreach: string | number }>(sql`SELECT COUNT(*)::int AS "totalOutreach" FROM outreach_logs WHERE project_id = ${projectId} AND status = ${SENT}`),
    // Channel mix counts confirmed activity only — exclude in-flight rows
    // ('pending_review' drafts and 'pre_send' allocations) so neither a
    // queued draft nor a stuck skill submit skews the breakdown.
    rawQuery<{ channel: Channel; count: string | number }>(sql`SELECT channel, COUNT(*)::int AS count FROM outreach_logs WHERE project_id = ${projectId} AND status IN (${SENT}, ${FAILED}) GROUP BY channel`),
    rawQuery<{ totalResponses: string | number; uniqueResponders: string | number }>(sql`SELECT COUNT(r.id)::int AS "totalResponses", COUNT(DISTINCT ol.prospect_id)::int AS "uniqueResponders"
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}`),
    rawQuery<{ sentiment: Sentiment; responseType: ResponseType; count: string | number }>(sql`SELECT r.sentiment, r.response_type AS "responseType", COUNT(*)::int AS count
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}
                 GROUP BY r.sentiment, r.response_type`),
    rawQuery<{ priority: string | number; total: string | number; responses: string | number; rate: string | number | null }>(sql`SELECT pp.priority,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses,
                   ROUND(COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::numeric / NULLIF(COUNT(DISTINCT ol.id), 0) * 100, 1)::float AS rate
                 FROM project_prospects pp
                 LEFT JOIN outreach_logs ol ON ol.project_id = pp.project_id AND ol.prospect_id = pp.prospect_id AND ol.status = ${SENT}
                 LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE pp.project_id = ${projectId}
                 GROUP BY pp.priority ORDER BY pp.priority`),
    rawQuery<{ status: ProspectStatus; count: string | number }>(sql`SELECT status, COUNT(*)::int AS count FROM project_prospects WHERE project_id = ${projectId} GROUP BY status`),
    // responses is 1:N to a send (no unique on outreach_log_id), so COUNT(DISTINCT ol.id) avoids double-counting.
    rawQuery<{ channel: Channel; total: string | number; responses: string | number }>(sql`SELECT ol.channel,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses
                 FROM outreach_logs ol LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} GROUP BY ol.channel`),
    // NULLIF(TRIM(industry)): some write paths (prospect-import) don't trim, so blank/whitespace would otherwise split into separate buckets.
    rawQuery<{ channel: Channel; industry: string | null; total: string | number; responses: string | number }>(sql`SELECT ol.channel, NULLIF(TRIM(p.industry), '') AS industry,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses
                 FROM outreach_logs ol
                   JOIN prospects p ON p.id = ol.prospect_id
                   LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                 GROUP BY ol.channel, NULLIF(TRIM(p.industry), '')`),
    // Bounce denominator is threadable email sends (bounceEligible), not total: a form/SNS send can't bounce.
    // Reply metrics count mature sends only (parity with the other axes); bounce
    // metrics span all sends — evaluate's early demote signal must not lag the maturity window.
    rawQuery<{ strategy: string | null; total: string | number; responses: string | number; bounces: string | number; bounceEligible: string | number }>(sql`SELECT p.discovery_strategy AS strategy,
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.sent_at < ${matureBefore})::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply') AND ol.sent_at < ${matureBefore})::int AS responses,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.response_type = 'bounce' AND ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS bounces,
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS "bounceEligible"
                 FROM outreach_logs ol
                   JOIN prospects p ON p.id = ol.prospect_id
                   LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                 GROUP BY p.discovery_strategy`),
    // Industry groups fine in SQL and folds to coarse in app — coarseIndustry() can't run in SQL.
    rawQuery<{ industry: string | null; total: string | number; responses: string | number; bounces: string | number; bounceEligible: string | number }>(sql`SELECT NULLIF(TRIM(p.industry), '') AS industry,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.response_type = 'bounce' AND ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS bounces,
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS "bounceEligible"
                 FROM outreach_logs ol
                   JOIN prospects p ON p.id = ol.prospect_id
                   LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} AND ol.sent_at < ${matureBefore}
                 GROUP BY NULLIF(TRIM(p.industry), '')`),
    rawQuery<{ employeeBand: EmployeeBand; total: string | number; responses: string | number; bounces: string | number; bounceEligible: string | number }>(sql`SELECT o.employee_band AS "employeeBand",
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.response_type = 'bounce' AND ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS bounces,
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS "bounceEligible"
                 FROM outreach_logs ol
                   JOIN prospects p ON p.id = ol.prospect_id
                   JOIN organizations o ON o.id = p.organization_id
                   LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} AND ol.sent_at < ${matureBefore}
                 GROUP BY o.employee_band`),
    rawQuery<{ country: string | null; total: string | number; responses: string | number; bounces: string | number; bounceEligible: string | number }>(sql`SELECT COALESCE(p.country, o.country) AS country,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS responses,
                   COUNT(DISTINCT ol.id) FILTER (WHERE r.response_type = 'bounce' AND ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS bounces,
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.channel = 'email' AND ol.message_id IS NOT NULL)::int AS "bounceEligible"
                 FROM outreach_logs ol
                   JOIN prospects p ON p.id = ol.prospect_id
                   JOIN organizations o ON o.id = p.organization_id
                   LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} AND ol.sent_at < ${matureBefore}
                 GROUP BY COALESCE(p.country, o.country)`),
    // One row of FILTER aggregates, not GROUP BY had_fresh_signal: both buckets
    // always come back and no boolean parsing through the pooler.
    rawQuery<{ signalTotal: string | number; signalResponses: string | number; noSignalTotal: string | number; noSignalResponses: string | number }>(sql`SELECT
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.had_fresh_signal)::int AS "signalTotal",
                   COUNT(DISTINCT ol.id) FILTER (WHERE ol.had_fresh_signal AND r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS "signalResponses",
                   COUNT(DISTINCT ol.id) FILTER (WHERE NOT ol.had_fresh_signal)::int AS "noSignalTotal",
                   COUNT(DISTINCT ol.id) FILTER (WHERE NOT ol.had_fresh_signal AND r.id IS NOT NULL AND r.response_type NOT IN ('bounce', 'auto_reply'))::int AS "noSignalResponses"
                 FROM outreach_logs ol LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}`),
    rawQuery<{ id: string | number; channel: Channel; subject: string | null; body: string; sentiment: Sentiment; responseType: ResponseType }>(sql`SELECT ol.id, ol.channel, ol.subject, ol.body, r.sentiment, r.response_type AS "responseType"
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}`),
    rawQuery<{ id: string | number; channel: Channel; subject: string | null; body: string }>(sql`SELECT ol.id, ol.channel, ol.subject, ol.body
                 FROM outreach_logs ol WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                   AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.outreach_log_id = ol.id)
                 ORDER BY ol.sent_at DESC LIMIT 10`),
    rawQuery<{ totalSent: string | number; lastSentAt: string | Date | null }>(sql`SELECT COUNT(*)::int AS "totalSent", MAX(sent_at) AS "lastSentAt"
                 FROM outreach_logs WHERE project_id = ${projectId} AND status = ${SENT}`),
    // inquiry_sessions has no project_id column — project scope flows through
    // outreach_logs.
    rawQuery<{ outcome: InquiryOutcome; count: string | number }>(sql`SELECT s.outcome, COUNT(*)::int AS count
                 FROM inquiry_sessions s
                 JOIN outreach_logs ol ON ol.id = s.outreach_log_id
                 WHERE ol.project_id = ${projectId}
                 GROUP BY s.outcome`),
    // Bucketed by UTC day to match the UTC-midnight quota window.
    rawQuery<{ day: string; count: string | number }>(sql`SELECT (sent_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
                 FROM outreach_logs
                 WHERE project_id = ${projectId} AND status = ${SENT}
                   AND sent_at >= ${trendSince}
                 GROUP BY day`),
    rawQuery<{ day: string; count: string | number }>(sql`SELECT (r.received_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId}
                   AND r.received_at >= ${trendSince}
                 GROUP BY day`),
    // archived_at (not a boolean expression) so pooler string-typing can't lie; null stays null.
    rawQuery<{ variantId: string; label: string | null; archivedAt: string | Date | null }>(sql`SELECT variant_id AS "variantId", label, archived_at AS "archivedAt"
                 FROM message_variants WHERE project_id = ${projectId}`),
  ])

  const totalOutreach = Number(totalOutreachRows[0]?.totalOutreach ?? 0)
  const lastSentRow = lastSentRows[0]
  const totalSent = Number(lastSentRow?.totalSent ?? 0)
  const lastSentAt = lastSentRow?.lastSentAt ?? null
  const daysSinceLastSend = lastSentAt
    ? Math.floor((Date.now() - new Date(lastSentAt).getTime()) / 86_400_000)
    : null

  // Seed every outcome at 0 so the response shape is stable when a project
  // has no sessions for a given outcome (or no sessions at all).
  const inquiryOutcomeCounts = Object.fromEntries(
    INQUIRY_OUTCOMES.map((o) => [o, 0]),
  ) as Record<InquiryOutcome, number>
  for (const row of inquiryOutcomeRows) {
    inquiryOutcomeCounts[row.outcome] = Number(row.count)
  }

  const variantMeta = new Map(
    variantMetaRows.map((r) => [r.variantId, { label: r.label, active: r.archivedAt === null }]),
  )
  const variantStats = await getVariantStats(db, projectId, config)
  const variantResponseRate: EvaluationMetrics['variantResponseRate'] = variantStats.map((v) => ({
    variantId: v.variantId,
    label: variantMeta.get(v.variantId)?.label ?? null,
    active: variantMeta.get(v.variantId)?.active ?? false,
    total: v.total,
    responses: v.responses,
    rate: v.total === 0 ? 0 : Math.round((v.responses / v.total) * 1000) / 10,
    meanReward: v.total === 0 ? 0 : Math.round((v.rewardSum / v.total) * 1000) / 1000,
  }))

  type AxisCounts = { total: number; responses: number; bounces: number; bounceEligible: number }
  const axisCounts = (r: {
    total: string | number
    responses: string | number
    bounces: string | number
    bounceEligible: string | number
  }): AxisCounts => ({
    total: Number(r.total),
    responses: Number(r.responses),
    bounces: Number(r.bounces),
    bounceEligible: Number(r.bounceEligible),
  })
  const axisBucket = ({ total, responses, bounces, bounceEligible }: AxisCounts) => ({
    total,
    responses,
    rate: total === 0 ? 0 : Math.round((responses / total) * 1000) / 10,
    bounces,
    bounceRate: bounceEligible === 0 ? 0 : Math.round((bounces / bounceEligible) * 1000) / 10,
  })
  const axisSort = (a: { total: number; rate: number }, b: { total: number; rate: number }) =>
    b.total - a.total || b.rate - a.rate

  const industryAgg = new Map<CoarseIndustry, AxisCounts>()
  for (const row of industryRows) {
    const key = coarseIndustry(row.industry)
    const entry = industryAgg.get(key) ?? { total: 0, responses: 0, bounces: 0, bounceEligible: 0 }
    const counts = axisCounts(row)
    entry.total += counts.total
    entry.responses += counts.responses
    entry.bounces += counts.bounces
    entry.bounceEligible += counts.bounceEligible
    industryAgg.set(key, entry)
  }

  const metrics: EvaluationMetrics = {
    totalOutreach,
    channelCounts: channelCountsRows.map((r) => ({ channel: r.channel, count: Number(r.count) })),
    responseCounts: {
      totalResponses: Number(responseCountsRows[0]?.totalResponses ?? 0),
      uniqueResponders: Number(responseCountsRows[0]?.uniqueResponders ?? 0),
    },
    sentimentBreakdown: sentimentBreakdownRows.map((r) => ({
      sentiment: r.sentiment,
      responseType: r.responseType,
      count: Number(r.count),
    })),
    priorityResponseRate: priorityResponseRateRows.map((r) => ({
      priority: Number(r.priority),
      total: Number(r.total),
      responses: Number(r.responses),
      rate: Number(r.rate ?? 0),
    })),
    statusCounts: statusCountsRows.map((r) => ({ status: r.status, count: Number(r.count) })),
    channelResponseRate: channelResponseRateRows.map((r) => {
      const total = Number(r.total)
      const responses = Number(r.responses)
      return {
        channel: r.channel,
        total,
        responses,
        rate: total === 0 ? 0 : Math.round((responses / total) * 1000) / 10,
      }
    }),
    channelByIndustry: channelByIndustryRows
      .map((r) => {
        const total = Number(r.total)
        const responses = Number(r.responses)
        return {
          channel: r.channel,
          industry: r.industry,
          total,
          responses,
          rate: total === 0 ? 0 : Math.round((responses / total) * 1000) / 10,
        }
      })
      .sort((a, b) => b.total - a.total || b.rate - a.rate),
    discoveryStrategyResponseRate: discoveryStrategyRows
      .map((r) => {
        const total = Number(r.total)
        const responses = Number(r.responses)
        const bounces = Number(r.bounces)
        const bounceEligible = Number(r.bounceEligible)
        return {
          strategy: r.strategy,
          total,
          responses,
          rate: total === 0 ? 0 : Math.round((responses / total) * 1000) / 10,
          bounces,
          bounceRate: bounceEligible === 0 ? 0 : Math.round((bounces / bounceEligible) * 1000) / 10,
        }
      })
      .sort((a, b) => b.total - a.total || b.rate - a.rate),
    industryResponseRate: Array.from(industryAgg, ([industry, counts]) => ({
      industry,
      ...axisBucket(counts),
    })).sort(axisSort),
    sizeResponseRate: sizeRows
      .map((r) => ({ employeeBand: r.employeeBand, ...axisBucket(axisCounts(r)) }))
      .sort(axisSort),
    countryResponseRate: countryRows
      .map((r) => ({ country: r.country, ...axisBucket(axisCounts(r)) }))
      .sort(axisSort),
    freshSignalResponseRate: (() => {
      const row = freshSignalRows[0]
      const bucket = (total: number, responses: number) => ({
        total,
        responses,
        rate: total === 0 ? 0 : Math.round((responses / total) * 1000) / 10,
      })
      return {
        withSignal: bucket(Number(row?.signalTotal ?? 0), Number(row?.signalResponses ?? 0)),
        withoutSignal: bucket(Number(row?.noSignalTotal ?? 0), Number(row?.noSignalResponses ?? 0)),
      }
    })(),
    variantResponseRate,
    inquiryOutcomeCounts,
  }

  // Zero-activity days are omitted to keep the table compact.
  const dailyMap = new Map<string, DailyActivity>()
  for (const row of dailySentRows) {
    dailyMap.set(row.day, { date: row.day, sent: Number(row.count), responses: 0 })
  }
  for (const row of dailyResponseRows) {
    const entry = dailyMap.get(row.day) ?? { date: row.day, sent: 0, responses: 0 }
    entry.responses = Number(row.count)
    dailyMap.set(row.day, entry)
  }
  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  )

  return ok({
    metrics,
    respondedMessages: respondedMessagesRows.map((r) => ({
      id: Number(r.id),
      channel: r.channel,
      subject: r.subject,
      body: r.body,
      sentiment: r.sentiment,
      responseType: r.responseType,
    })),
    noResponseSample: noResponseSampleRows.map((r) => ({
      id: Number(r.id),
      channel: r.channel,
      subject: r.subject,
      body: r.body,
    })),
    dataSufficiency: {
      sufficient: totalSent >= 30 && (daysSinceLastSend === null || daysSinceLastSend >= 3),
      totalSent,
      daysSinceLastSend,
    },
    dailyActivity,
  })
}

