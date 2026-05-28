import { z } from 'zod'
import { eq, and, sql, desc, inArray } from 'drizzle-orm'
import {
  evaluations,
  projectProspects,
  prospects,
  prioritySchema,
  INQUIRY_OUTCOMES,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutreachStatus,
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

export type ProjectStatsResult = {
  metrics: EvaluationMetrics
  respondedMessages: Row[]
  noResponseSample: Row[]
  dataSufficiency: {
    sufficient: boolean
    totalSent: number
    daysSinceLastSend: number | null
  }
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

  return ok({
    metrics,
    respondedMessages: respondedMessagesRows,
    noResponseSample: noResponseSampleRows,
    dataSufficiency: {
      sufficient: totalSent >= 30 && (daysSinceLastSend === null || daysSinceLastSend >= 3),
      totalSent,
      daysSinceLastSend,
    },
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

  // Apply per-industry priority overrides as a small linear loop. The list
  // is capped in the schema (max 50, no duplicates), and /evaluate is a
  // batch-cadence endpoint, so there's no reason to reach for Promise.all.
  const priorityResults: Array<{ industry: string; rowsAffected: number }> = []
  for (const pu of input.priorityUpdates ?? []) {
    const updated = await db
      .update(projectProspects)
      .set({ priority: pu.priority, updatedAt: now })
      .where(
        and(
          eq(projectProspects.projectId, input.projectId),
          eq(projectProspects.status, 'new'),
          inArray(
            projectProspects.prospectId,
            db.select({ id: prospects.id }).from(prospects).where(eq(prospects.industry, pu.industry)),
          ),
        ),
      )
      .returning({ id: projectProspects.id })

    priorityResults.push({ industry: pu.industry, rowsAffected: updated.length })
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
