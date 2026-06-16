import { z } from 'zod'
import { sql } from 'drizzle-orm'
import {
  prioritySchema,
  INQUIRY_OUTCOMES,
  responseTypeEnum,
  sentimentEnum,
  type Channel,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutreachStatus,
  type ProspectStatus,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  projectRefSchema,
  type ProjectId,
  type ProjectRef,
  type TenantId,
} from '../domain/ids'
import { replyReward } from '../domain/reward'
import { type LeverConfig } from '../domain/lever-config'
import type { VariantStat } from '../domain/subject-bandit'
import type { ChannelFineStat } from '../domain/channel-affinity'
import { loadLeverConfig } from './project-settings'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'

const priorityUpdateSchema = z.object({
  industry: z.string().min(1),
  priority: prioritySchema,
})

// `/evaluate` persists its conclusions only as per-industry prospect-priority
// overrides — the analysis is reported to the user and distilled into the
// `learnings` doc, not stored. priorityUpdates is required + non-empty: a run
// with no priority changes carries no work, so the skill skips this call
// entirely rather than sending an empty array (which the API rejects with 400).
export const recordEvaluationSchema = z.object({
  projectId: projectRefSchema,
  priorityUpdates: z
    .array(priorityUpdateSchema)
    .min(1)
    .max(50)
    .refine((arr) => new Set(arr.map((x) => x.industry)).size === arr.length, {
      message: 'priorityUpdates contains duplicate industries',
    }),
})
export type RecordEvaluationInput = z.infer<typeof recordEvaluationSchema>

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

// Per-variant aggregate over the reply-mature window (shared by getProjectStats
// and run_lever_tick). `responses` is COUNT(DISTINCT replied send) so it stays ≤
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
  // Forgetting lower bound (opt-in). Empty fragment when unset/disabled, so the SQL is
  // byte-for-byte today's. Two variants because the denom query uses bare `sent_at`
  // while the response/reward queries alias it `ol.sent_at`.
  const lookbackDays =
    applyLookback && config.rewardLookbackDays !== undefined
      ? config.rewardWindowDays + config.rewardLookbackDays
      : undefined
  const forgetBare = lookbackDays === undefined ? sql`` : sql` AND sent_at >= now() - make_interval(days => ${lookbackDays})`
  const forgetOl = lookbackDays === undefined ? sql`` : sql` AND ol.sent_at >= now() - make_interval(days => ${lookbackDays})`
  const exec = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [denomRows, responseRows, rewardRows] = await Promise.all([
    exec<{ variantId: string; total: string | number }>(sql`SELECT variant_id AS "variantId", COUNT(*)::int AS total
             FROM outreach_logs
             WHERE project_id = ${projectId} AND status = ${SENT}
               AND variant_id IS NOT NULL AND sent_at < ${matureBefore}${forgetBare}
             GROUP BY variant_id ORDER BY variant_id`),
    exec<{ variantId: string; responses: string | number }>(sql`SELECT ol.variant_id AS "variantId", COUNT(DISTINCT ol.id)::int AS responses
             FROM outreach_logs ol JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.variant_id IS NOT NULL AND ol.sent_at < ${matureBefore}${forgetOl}
               AND r.response_type NOT IN ('bounce', 'auto_reply')
             GROUP BY ol.variant_id`),
    exec<{ variantId: string; responseType: ResponseType; sentiment: Sentiment; count: string | number }>(sql`SELECT ol.variant_id AS "variantId", r.response_type AS "responseType", r.sentiment, COUNT(*)::int AS count
             FROM outreach_logs ol JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.variant_id IS NOT NULL AND ol.sent_at < ${matureBefore}${forgetOl}
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
  const exec = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [denomRows, responseRows] = await Promise.all([
    exec<{ channel: Channel; industry: string | null; total: string | number }>(sql`SELECT ol.channel AS "channel", p.industry AS "industry", COUNT(*)::int AS total
             FROM outreach_logs ol JOIN prospects p ON p.id = ol.prospect_id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.sent_at < ${matureBefore}
             GROUP BY ol.channel, p.industry`),
    exec<{ channel: Channel; industry: string | null; responses: string | number }>(sql`SELECT ol.channel AS "channel", p.industry AS "industry", COUNT(DISTINCT ol.id)::int AS responses
             FROM outreach_logs ol
               JOIN prospects p ON p.id = ol.prospect_id
               JOIN responses r ON r.outreach_log_id = ol.id
             WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
               AND ol.sent_at < ${matureBefore}
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

  const [
    totalOutreachRows,
    channelCountsRows,
    responseCountsRows,
    sentimentBreakdownRows,
    priorityResponseRateRows,
    statusCountsRows,
    channelResponseRateRows,
    respondedMessagesRows,
    noResponseSampleRows,
    lastSentRows,
    inquiryOutcomeRows,
    dailySentRows,
    dailyResponseRows,
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
                   COUNT(DISTINCT r.id)::int AS responses,
                   ROUND(COUNT(DISTINCT r.id)::numeric / NULLIF(COUNT(DISTINCT ol.id), 0) * 100, 1)::float AS rate
                 FROM project_prospects pp
                 LEFT JOIN outreach_logs ol ON ol.project_id = pp.project_id AND ol.prospect_id = pp.prospect_id AND ol.status = ${SENT}
                 LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE pp.project_id = ${projectId}
                 GROUP BY pp.priority ORDER BY pp.priority`),
    rawQuery<{ status: ProspectStatus; count: string | number }>(sql`SELECT status, COUNT(*)::int AS count FROM project_prospects WHERE project_id = ${projectId} GROUP BY status`),
    // Per-channel response rate uses confirmed activity for the denominator
    // (matches channelCounts above) — in-flight rows have no chance of
    // being responded to yet, so including them would dilute the rate.
    rawQuery<{ channel: Channel; total: string | number; responses: string | number; rate: string | number | null }>(sql`SELECT ol.channel,
                   COUNT(ol.id)::int AS total,
                   COUNT(r.id)::int AS responses,
                   ROUND(COUNT(r.id)::numeric / NULLIF(COUNT(ol.id), 0) * 100, 1)::float AS rate
                 FROM outreach_logs ol LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status IN (${SENT}, ${FAILED}) GROUP BY ol.channel`),
    rawQuery<{ id: string | number; channel: Channel; subject: string | null; body: string; sentiment: Sentiment; responseType: ResponseType }>(sql`SELECT ol.id, ol.channel, ol.subject, ol.body, r.sentiment, r.response_type AS "responseType"
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}`),
    rawQuery<{ id: string | number; channel: Channel; subject: string | null; body: string }>(sql`SELECT ol.id, ol.channel, ol.subject, ol.body
                 FROM outreach_logs ol WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                   AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.outreach_log_id = ol.id)
                 ORDER BY ol.sent_at DESC LIMIT 10`),
    rawQuery<{ totalSent: string | number; lastSentAt: string | Date | null }>(sql`SELECT COUNT(*)::int AS "totalSent", MAX(sent_at) AS "lastSentAt"
                 FROM outreach_logs WHERE project_id = ${projectId} AND status = ${SENT}`),
    // inquiry_sessions has no project_id column — project scope flows through
    // outreach_logs. Counts every session ever opened for this project,
    // grouped by terminal-or-current outcome.
    rawQuery<{ outcome: InquiryOutcome; count: string | number }>(sql`SELECT s.outcome, COUNT(*)::int AS count
                 FROM inquiry_sessions s
                 JOIN outreach_logs ol ON ol.id = s.outreach_log_id
                 WHERE ol.project_id = ${projectId}
                 GROUP BY s.outcome`),
    // Daily sent / response counts over the last 30 days, bucketed by UTC day
    // (matches the UTC-midnight quota window). Drives the activity-trend table.
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

  const config = await loadLeverConfig(db, projectId)
  const variantStats = await getVariantStats(db, projectId, config)
  const variantResponseRate: EvaluationMetrics['variantResponseRate'] = variantStats.map((v) => ({
    variantId: v.variantId,
    total: v.total,
    responses: v.responses,
    rate: v.total === 0 ? 0 : Math.round((v.responses / v.total) * 1000) / 10,
    meanReward: v.total === 0 ? 0 : Math.round((v.rewardSum / v.total) * 1000) / 1000,
  }))

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
    channelResponseRate: channelResponseRateRows.map((r) => ({
      channel: r.channel,
      total: Number(r.total),
      responses: Number(r.responses),
      rate: Number(r.rate ?? 0),
    })),
    variantResponseRate,
    inquiryOutcomeCounts,
  }

  // Daily activity trend (last 30d, UTC day boundary). Only days with at least
  // one sent or one response appear — zero-activity days are omitted to keep
  // the table compact. Derived live; no stored snapshot (the raw outreach_logs
  // / responses rows are the single source of truth).
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

export type RecordEvaluationResult = {
  priorityUpdates: Array<{ industry: string; rowsAffected: number }>
}

export async function recordEvaluation(
  db: Db,
  tenantId: TenantId,
  input: RecordEvaluationInput,
): Promise<ServiceResult<RecordEvaluationResult>> {
  const resolved = await resolveProject(db, tenantId, input.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  // Apply every per-industry priority override in a single
  // UPDATE ... FROM (VALUES ...) so the endpoint issues one round-trip
  // regardless of list size. The schema caps the list (max 50, no duplicate
  // industries); RETURNING the matched industry lets us report per-industry
  // rowsAffected. Only 'new' rows are touched.
  //
  // Raw db.execute bypasses drizzle's column-type mappers, so two casts the
  // builder would normally insert must be written by hand against postgres-js's
  // text-typed bind params: `${NEW}::prospect_status` (enum column = text param
  // has no operator) and `now()` instead of a JS Date param (postgres-js's cf
  // build can't serialize a Date in this raw bind path).
  const NEW: ProspectStatus = 'new'
  const valuesList = sql.join(
    input.priorityUpdates.map((pu) => sql`(${pu.industry}::text, ${pu.priority}::int)`),
    sql`, `,
  )
  const updatedRows = Array.from(
    await db.execute<{ industry: string }>(sql`
      UPDATE project_prospects pp
      SET priority = v.priority, updated_at = now()
      FROM (VALUES ${valuesList}) AS v(industry, priority)
      JOIN prospects p ON p.industry = v.industry
      WHERE pp.prospect_id = p.id AND pp.project_id = ${projectId} AND pp.status = ${NEW}::prospect_status
      RETURNING v.industry AS industry
    `),
  )
  // Seed every requested industry at 0 so an industry that matched no 'new'
  // prospect still appears in the result.
  const counts = new Map<string, number>(input.priorityUpdates.map((pu) => [pu.industry, 0]))
  for (const row of updatedRows) {
    counts.set(row.industry, (counts.get(row.industry) ?? 0) + 1)
  }

  return ok({
    priorityUpdates: input.priorityUpdates.map((pu) => ({
      industry: pu.industry,
      rowsAffected: counts.get(pu.industry) ?? 0,
    })),
  })
}
