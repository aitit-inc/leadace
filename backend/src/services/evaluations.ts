import { z } from 'zod'
import { eq, sql, desc } from 'drizzle-orm'
import {
  evaluations,
  prioritySchema,
  INQUIRY_OUTCOMES,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutreachStatus,
  type ProspectStatus,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  projectIdSchema,
  type ProjectId,
  type TenantId,
} from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'

const priorityUpdateSchema = z.object({
  industry: z.string().min(1),
  priority: prioritySchema,
})

export const listEvaluationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ListEvaluationsQuery = z.infer<typeof listEvaluationsQuerySchema>

export const recordEvaluationSchema = z.object({
  projectId: projectIdSchema,
  metrics: z.record(z.string(), z.unknown()),
  findings: z.string().min(1),
  improvements: z.string().min(1),
  priorityUpdates: z
    .array(priorityUpdateSchema)
    .max(50)
    .refine((arr) => new Set(arr.map((x) => x.industry)).size === arr.length, {
      message: 'priorityUpdates contains duplicate industries',
    })
    .optional(),
})
export type RecordEvaluationInput = z.infer<typeof recordEvaluationSchema>

// Aggregation-heavy: 10 independent COUNT/GROUP BY queries pipelined over the
// RLS transaction connection. Most rely on `COUNT() FILTER (WHERE ...)`,
// multi-table joins, or `ROUND(... NULLIF, 1)::float` ratios that drizzle's
// typed builder doesn't express directly. Each query returns a well-known
// shape that we cast into `EvaluationMetrics`; if the SQL or the result type
// drifts, both edits land here.

type Row = Record<string, unknown>

export type DailyActivity = { date: string; sent: number; responses: number }

export type ProjectStatsResult = {
  metrics: EvaluationMetrics
  respondedMessages: Row[]
  noResponseSample: Row[]
  dataSufficiency: {
    sufficient: boolean
    totalSent: number
    daysSinceLastSend: number | null
  }
  dailyActivity: DailyActivity[]
}

export async function getProjectStats(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<ProjectStatsResult>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const rawQuery = async (query: ReturnType<typeof sql>): Promise<Row[]> => {
    const result = await db.execute(query)
    return Array.from(result) as Row[]
  }

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
    rawQuery(sql`SELECT COUNT(*)::int AS "totalOutreach" FROM outreach_logs WHERE project_id = ${projectId} AND status = ${SENT}`),
    // Channel mix counts confirmed activity only — exclude in-flight rows
    // ('pending_review' drafts and 'pre_send' allocations) so neither a
    // queued draft nor a stuck skill submit skews the breakdown.
    rawQuery(sql`SELECT channel, COUNT(*)::int AS count FROM outreach_logs WHERE project_id = ${projectId} AND status IN (${SENT}, ${FAILED}) GROUP BY channel`),
    rawQuery(sql`SELECT COUNT(r.id)::int AS "totalResponses", COUNT(DISTINCT ol.prospect_id)::int AS "uniqueResponders"
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}`),
    rawQuery(sql`SELECT r.sentiment, r.response_type AS "responseType", COUNT(*)::int AS count
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}
                 GROUP BY r.sentiment, r.response_type`),
    rawQuery(sql`SELECT pp.priority,
                   COUNT(DISTINCT ol.id)::int AS total,
                   COUNT(DISTINCT r.id)::int AS responses,
                   ROUND(COUNT(DISTINCT r.id)::numeric / NULLIF(COUNT(DISTINCT ol.id), 0) * 100, 1)::float AS rate
                 FROM project_prospects pp
                 LEFT JOIN outreach_logs ol ON ol.project_id = pp.project_id AND ol.prospect_id = pp.prospect_id AND ol.status = ${SENT}
                 LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE pp.project_id = ${projectId}
                 GROUP BY pp.priority ORDER BY pp.priority`),
    rawQuery(sql`SELECT status, COUNT(*)::int AS count FROM project_prospects WHERE project_id = ${projectId} GROUP BY status`),
    // Per-channel response rate uses confirmed activity for the denominator
    // (matches channelCounts above) — in-flight rows have no chance of
    // being responded to yet, so including them would dilute the rate.
    rawQuery(sql`SELECT ol.channel,
                   COUNT(ol.id)::int AS total,
                   COUNT(r.id)::int AS responses,
                   ROUND(COUNT(r.id)::numeric / NULLIF(COUNT(ol.id), 0) * 100, 1)::float AS rate
                 FROM outreach_logs ol LEFT JOIN responses r ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId} AND ol.status IN (${SENT}, ${FAILED}) GROUP BY ol.channel`),
    rawQuery(sql`SELECT ol.id, ol.channel, ol.subject, ol.body, r.sentiment, r.response_type AS "responseType"
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id WHERE ol.project_id = ${projectId}`),
    rawQuery(sql`SELECT ol.id, ol.channel, ol.subject, ol.body
                 FROM outreach_logs ol WHERE ol.project_id = ${projectId} AND ol.status = ${SENT}
                   AND NOT EXISTS (SELECT 1 FROM responses r WHERE r.outreach_log_id = ol.id)
                 ORDER BY ol.sent_at DESC LIMIT 10`),
    rawQuery(sql`SELECT COUNT(*)::int AS "totalSent", MAX(sent_at) AS "lastSentAt"
                 FROM outreach_logs WHERE project_id = ${projectId} AND status = ${SENT}`),
    // inquiry_sessions has no project_id column — project scope flows through
    // outreach_logs. Counts every session ever opened for this project,
    // grouped by terminal-or-current outcome.
    rawQuery(sql`SELECT s.outcome, COUNT(*)::int AS count
                 FROM inquiry_sessions s
                 JOIN outreach_logs ol ON ol.id = s.outreach_log_id
                 WHERE ol.project_id = ${projectId}
                 GROUP BY s.outcome`),
    // Daily sent / response counts over the last 30 days, bucketed by UTC day
    // (matches the UTC-midnight quota window). Drives the activity-trend table.
    rawQuery(sql`SELECT (sent_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
                 FROM outreach_logs
                 WHERE project_id = ${projectId} AND status = ${SENT}
                   AND sent_at >= ${trendSince}
                 GROUP BY day`),
    rawQuery(sql`SELECT (r.received_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
                 FROM responses r JOIN outreach_logs ol ON r.outreach_log_id = ol.id
                 WHERE ol.project_id = ${projectId}
                   AND r.received_at >= ${trendSince}
                 GROUP BY day`),
  ])

  const totalOutreach = (totalOutreachRows[0]?.['totalOutreach'] as number | undefined) ?? 0
  const lastSentRow = lastSentRows[0]
  const totalSent = (lastSentRow?.['totalSent'] as number | undefined) ?? 0
  const lastSentAt = (lastSentRow?.['lastSentAt'] as string | null | undefined) ?? null
  const daysSinceLastSend = lastSentAt
    ? Math.floor((Date.now() - new Date(lastSentAt).getTime()) / 86_400_000)
    : null

  // Seed every outcome at 0 so the response shape is stable when a project
  // has no sessions for a given outcome (or no sessions at all).
  const inquiryOutcomeCounts = Object.fromEntries(
    INQUIRY_OUTCOMES.map((o) => [o, 0]),
  ) as Record<InquiryOutcome, number>
  for (const row of inquiryOutcomeRows) {
    const outcome = row['outcome'] as InquiryOutcome
    const count = (row['count'] as number | undefined) ?? 0
    inquiryOutcomeCounts[outcome] = count
  }

  const metrics: EvaluationMetrics = {
    totalOutreach,
    channelCounts: channelCountsRows as EvaluationMetrics['channelCounts'],
    responseCounts: (responseCountsRows[0] ?? { totalResponses: 0, uniqueResponders: 0 }) as EvaluationMetrics['responseCounts'],
    sentimentBreakdown: sentimentBreakdownRows as EvaluationMetrics['sentimentBreakdown'],
    priorityResponseRate: priorityResponseRateRows as EvaluationMetrics['priorityResponseRate'],
    statusCounts: statusCountsRows as EvaluationMetrics['statusCounts'],
    channelResponseRate: channelResponseRateRows as EvaluationMetrics['channelResponseRate'],
    inquiryOutcomeCounts,
  }

  // Daily activity trend (last 30d, UTC day boundary). Only days with at least
  // one sent or one response appear — zero-activity days are omitted to keep
  // the table compact. Derived live; no stored snapshot (the raw outreach_logs
  // / responses rows are the single source of truth).
  const dailyMap = new Map<string, DailyActivity>()
  for (const row of dailySentRows) {
    const date = row['day'] as string
    dailyMap.set(date, { date, sent: (row['count'] as number | undefined) ?? 0, responses: 0 })
  }
  for (const row of dailyResponseRows) {
    const date = row['day'] as string
    const entry = dailyMap.get(date) ?? { date, sent: 0, responses: 0 }
    entry.responses = (row['count'] as number | undefined) ?? 0
    dailyMap.set(date, entry)
  }
  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) =>
    a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
  )

  return ok({
    metrics,
    respondedMessages: respondedMessagesRows,
    noResponseSample: noResponseSampleRows,
    dataSufficiency: {
      sufficient: totalSent >= 30 && (daysSinceLastSend === null || daysSinceLastSend >= 3),
      totalSent,
      daysSinceLastSend,
    },
    dailyActivity,
  })
}

export type RecordEvaluationResult = {
  evaluationId: number | undefined
  priorityUpdates: Array<{ industry: string; rowsAffected: number }>
}

export async function recordEvaluation(
  db: Db,
  tenantId: TenantId,
  input: RecordEvaluationInput,
): Promise<ServiceResult<RecordEvaluationResult>> {
  const guard = await requireProject(db, input.projectId, tenantId)
  if (!guard.ok) return guard

  const now = new Date()

  const [evaluation] = await db
    .insert(evaluations)
    .values({
      tenantId,
      projectId: input.projectId,
      evaluationDate: now,
      metrics: input.metrics as EvaluationMetrics,
      findings: input.findings,
      improvements: input.improvements,
    })
    .returning({ id: evaluations.id })

  // Apply every per-industry priority override in a single
  // UPDATE ... FROM (VALUES ...) so the endpoint issues one round-trip
  // regardless of list size. The schema caps the list (max 50, no duplicate
  // industries); RETURNING the matched industry lets us report per-industry
  // rowsAffected. Only 'new' rows are touched, matching the prior behavior.
  const priorityUpdates = input.priorityUpdates ?? []
  let priorityResults: Array<{ industry: string; rowsAffected: number }> = []
  if (priorityUpdates.length > 0) {
    const NEW: ProspectStatus = 'new'
    const valuesList = sql.join(
      priorityUpdates.map((pu) => sql`(${pu.industry}::text, ${pu.priority}::int)`),
      sql`, `,
    )
    const updatedRows = Array.from(
      await db.execute(sql`
        UPDATE project_prospects pp
        SET priority = v.priority, updated_at = ${now}
        FROM (VALUES ${valuesList}) AS v(industry, priority)
        JOIN prospects p ON p.industry = v.industry
        WHERE pp.prospect_id = p.id AND pp.project_id = ${input.projectId} AND pp.status = ${NEW}
        RETURNING v.industry AS industry
      `),
    ) as Row[]
    // Seed every requested industry at 0 so an industry that matched no 'new'
    // prospect still appears in the result (preserves prior behavior).
    const counts = new Map<string, number>(priorityUpdates.map((pu) => [pu.industry, 0]))
    for (const row of updatedRows) {
      const industry = row['industry'] as string
      counts.set(industry, (counts.get(industry) ?? 0) + 1)
    }
    priorityResults = priorityUpdates.map((pu) => ({
      industry: pu.industry,
      rowsAffected: counts.get(pu.industry) ?? 0,
    }))
  }

  return ok({
    evaluationId: evaluation?.id,
    priorityUpdates: priorityResults,
  })
}

export type EvaluationHistoryRow = {
  id: number
  evaluationDate: Date
  findings: string
  improvements: string
}

export async function listEvaluations(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: ListEvaluationsQuery,
): Promise<ServiceResult<{ evaluations: EvaluationHistoryRow[]; total: number }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const { limit, offset } = query
  const where = eq(evaluations.projectId, projectId)

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: evaluations.id,
        evaluationDate: evaluations.evaluationDate,
        findings: evaluations.findings,
        improvements: evaluations.improvements,
      })
      .from(evaluations)
      .where(where)
      .orderBy(desc(evaluations.evaluationDate), desc(evaluations.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(evaluations)
      .where(where),
  ])

  return ok({
    evaluations: rows as EvaluationHistoryRow[],
    total: countRows[0]?.total ?? 0,
  })
}
