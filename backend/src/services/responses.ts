import { z } from 'zod'
import { eq, and, desc, sql, gte, isNotNull, ilike } from 'drizzle-orm'
import {
  outreachLogs,
  responses,
  projects,
  projectProspects,
  prospects,
  organizations,
  sentimentEnum,
  responseTypeEnum,
  channelEnum,
  REJECTION_RECONTACT_WINDOWS,
  type Channel,
  type RejectionFeedbackV1,
  type RejectionRecontactWindow,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  outreachLogIdSchema,
  type ProjectId,
  type TenantId,
} from '../domain/ids'
import {
  feedbackForcesDoNotContact,
  reapproachWindowMonths,
  resolveEffectiveReapproachWindow,
  rejectionFeedbackCommonSchema,
  PMF_RELEVANT_REASONS,
  FEATURE_GAP_REASON,
  NOT_RELEVANT_REASON,
  type DecisionMakerPointer,
} from '../domain/rejection-feedback'
import { addMonthsUtc, nextStatusFromResponse } from '../domain/prospect-status'
import { projectProspectInsertValues } from '../domain/project-prospect'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'
import { loadProjectReapproachSettings } from './project-settings'

const rejectionFeedbackSchema = rejectionFeedbackCommonSchema.extend({
  version: z.literal(1),
  decision_maker_pointer: z.object({
    name: z.string().max(200).optional(),
    email: z.email().max(320).optional(),
    role: z.string().max(200).optional(),
  }).optional(),
  submitted_at: z.iso.datetime(),
  tenant_signature: z.string().optional(),
})

export const recordResponseSchema = z.object({
  outreachLogId: outreachLogIdSchema,
  channel: z.enum(channelEnum.enumValues),
  content: z.string().min(1),
  sentiment: z.enum(sentimentEnum.enumValues),
  responseType: z.enum(responseTypeEnum.enumValues),
  // Clamped to [now-7d, now] so /check-results can pass Gmail's internalDate
  // for polling lag, but callers can't backdate to shift nextOutreachAfter.
  receivedAt: z.iso
    .datetime()
    .refine((s) => {
      const t = new Date(s).getTime()
      const now = Date.now()
      return t <= now && t >= now - 7 * 24 * 60 * 60 * 1000
    }, 'receivedAt must be within the last 7 days')
    .optional(),
  markDoNotContact: z.boolean().default(false),
  rejectionFeedback: rejectionFeedbackSchema.optional(),
})
export type RecordResponseInput = z.infer<typeof recordResponseSchema>

export const listResponsesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  sentiment: z.enum(sentimentEnum.enumValues).optional(),
  responseType: z.enum(responseTypeEnum.enumValues).optional(),
})
export type ListResponsesQuery = z.infer<typeof listResponsesQuerySchema>

// Lives in the service, not domain — shapes which SQL queries fire, not
// underlying rules.
const REJECTION_SCOPES = ['pmf', 'tactical', 'all'] as const
type RejectionScope = (typeof REJECTION_SCOPES)[number]

export const rejectionFeedbackSummaryQuerySchema = z.object({
  windowDays: z.coerce.number().int().min(1).max(3650).optional(),
  freeTextLimit: z.coerce.number().int().min(1).max(100).default(20),
  recontactLimit: z.coerce.number().int().min(1).max(100).default(20),
  notRelevantLimit: z.coerce.number().int().min(1).max(200).default(50),
  scope: z.enum(REJECTION_SCOPES).default('all'),
})
export type RejectionFeedbackSummaryQuery = z.infer<typeof rejectionFeedbackSummaryQuerySchema>

const DECISION_MAKER_LIMIT = 50

// Skip-if-not-needed wrapper so the gated arms incur zero DB cost.
function gated<T>(when: boolean, q: () => Promise<T>): Promise<T | null> {
  return when ? q() : Promise.resolve(null)
}

export type DerivedProspectAction = 'created' | 'matched_existing'
export type DerivedProspect = { id: number; name: string; action: DerivedProspectAction }

export type RecordResponseResult = {
  id: number | undefined
  derivedProspects: DerivedProspect[]
}

export async function recordResponse(
  db: Db,
  tenantId: TenantId,
  input: RecordResponseInput,
): Promise<ServiceResult<RecordResponseResult>> {
  if (input.rejectionFeedback && input.responseType !== 'rejection') {
    return err('INVALID_INPUT', 'rejectionFeedback may only be set when responseType is "rejection"')
  }

  const [log] = await db
    .select({
      id: outreachLogs.id,
      projectId: outreachLogs.projectId,
      prospectId: outreachLogs.prospectId,
    })
    .from(outreachLogs)
    .innerJoin(projects, eq(projects.id, outreachLogs.projectId))
    .where(and(eq(outreachLogs.id, input.outreachLogId), eq(projects.tenantId, tenantId)))
    .limit(1)

  if (!log) {
    return err('NOT_FOUND', 'Outreach log not found')
  }

  const now = new Date()
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : now

  const [reapproachSettings, [newResponse]] = await Promise.all([
    loadProjectReapproachSettings(db, log.projectId as ProjectId),
    db
      .insert(responses)
      .values({
        tenantId,
        outreachLogId: input.outreachLogId,
        channel: input.channel,
        content: input.content,
        sentiment: input.sentiment,
        responseType: input.responseType,
        receivedAt,
        rejectionFeedback: input.rejectionFeedback,
      })
      .returning({ id: responses.id }),
  ])

  // Cycle ratchet: count this prospect's rejections in THIS project (including
  // the row just inserted). Scoped per-project to match maxReapproachCycles
  // — project A rejections must not taint project B's counter. When the cap
  // is hit, a would-be 'deferred' is promoted to 'rejected' + DNC regardless
  // of stated recontact window.
  let rejectionCycle = 0
  if (input.responseType === 'rejection') {
    const [countRow] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(
        eq(outreachLogs.prospectId, log.prospectId),
        eq(outreachLogs.projectId, log.projectId),
        eq(responses.responseType, 'rejection'),
      ))
    rejectionCycle = countRow?.count ?? 0
  }
  const reapproachMonthsRaw = input.rejectionFeedback
    ? reapproachWindowMonths(input.rejectionFeedback, {
        unspecifiedMonths: reapproachSettings.unspecifiedRecontactWindowMonths,
      })
    : null
  // Cap-reached rejections lose the reapproach window: straight to 'rejected'
  // + DNC, no next_outreach_after stamped.
  const { cycleCapReached, effectiveWindowMonths: reapproachMonths } = resolveEffectiveReapproachWindow({
    responseType: input.responseType,
    rejectionCycle,
    maxReapproachCycles: reapproachSettings.maxReapproachCycles,
    requestedWindowMonths: reapproachMonthsRaw,
  })
  const newStatus = nextStatusFromResponse({
    responseType: input.responseType,
    sentiment: input.sentiment,
    reapproachMonths,
  })

  if (newStatus) {
    await db
      .update(projectProspects)
      .set({ status: newStatus, updatedAt: now })
      .where(
        and(
          eq(projectProspects.projectId, log.projectId),
          eq(projectProspects.prospectId, log.prospectId),
        ),
      )
  }

  if (reapproachMonths !== null) {
    // GREATEST so a longer pre-existing window (earlier rejection / no-response
    // recycle) is never shortened. Same rule as deferProspectReeligibility.
    const nextOutreachAfter = addMonthsUtc(receivedAt, reapproachMonths)
    const nextIso = nextOutreachAfter.toISOString()
    await db
      .update(prospects)
      .set({
        nextOutreachAfter: sql`GREATEST(${prospects.nextOutreachAfter}, ${nextIso}::timestamptz)`,
        updatedAt: now,
      })
      .where(eq(prospects.id, log.prospectId))
  }

  // DNC ratchet: caller-requested, bounce, hard opt-out, or cycle cap reached.
  const forceDnc = input.rejectionFeedback ? feedbackForcesDoNotContact(input.rejectionFeedback) : false
  if (input.markDoNotContact || input.responseType === 'bounce' || forceDnc || cycleCapReached) {
    await db
      .update(prospects)
      .set({ doNotContact: true, updatedAt: now })
      .where(eq(prospects.id, log.prospectId))
  }

  // Skipped when the rejection ratcheted DNC on the referring prospect —
  // a referral from someone who unsubscribed shouldn't seed a new contact.
  const derivedProspects: DerivedProspect[] = []
  const pointer = input.rejectionFeedback?.decision_maker_pointer
  if (pointer && !forceDnc) {
    const derived = await derivePointerProspect(db, tenantId, log.prospectId, pointer, now)
    if (derived) derivedProspects.push(derived)
  }

  return ok({
    id: newResponse?.id,
    derivedProspects,
  })
}

// Materialise a decision_maker_pointer into a prospect row.
//
// Dedup ladder:
//   1. pointer.email → (tenant, email). DNC blocks any update.
//      - hit: fill missing contactName/department only; never overwrite.
//      - miss: create new prospect inheriting org/overview/websiteUrl/industry
//        from the referring prospect, link it to every project the referring
//        prospect is in (priority preserved per-link).
//   2. pointer.email absent + pointer.name → (tenant, organizationId,
//      contactName ILIKE name). Hit fills missing department. Miss is a no-op
//      because a contact-channel-less prospect would violate the schema refine.
//   3. neither → no-op.
// Self-references (pointer matches referring prospect's own email/contactName)
// are skipped to avoid recursive defer/role-flip loops.
async function derivePointerProspect(
  db: Db,
  tenantId: TenantId,
  referringProspectId: number,
  pointer: DecisionMakerPointer,
  now: Date,
): Promise<DerivedProspect | null> {
  const pointerName = pointer.name?.trim() || null
  const pointerEmail = pointer.email?.trim() || null
  const pointerRole = pointer.role?.trim() || null

  if (!pointerName && !pointerEmail) return null

  const [referring] = await db
    .select({
      id: prospects.id,
      name: prospects.name,
      contactName: prospects.contactName,
      organizationId: prospects.organizationId,
      overview: prospects.overview,
      websiteUrl: prospects.websiteUrl,
      industry: prospects.industry,
      email: prospects.email,
    })
    .from(prospects)
    .where(eq(prospects.id, referringProspectId))
    .limit(1)

  if (!referring) return null

  if (pointerEmail && referring.email === pointerEmail) return null
  if (pointerName && referring.contactName && referring.contactName.toLowerCase() === pointerName.toLowerCase()) return null

  if (pointerEmail) {
    const [existing] = await db
      .select({
        id: prospects.id,
        name: prospects.name,
        contactName: prospects.contactName,
        department: prospects.department,
        doNotContact: prospects.doNotContact,
      })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), eq(prospects.email, pointerEmail)))
      .limit(1)

    if (existing) {
      if (existing.doNotContact) return null
      const patch: { contactName?: string; department?: string; updatedAt?: Date } = {}
      if (!existing.contactName && pointerName) patch.contactName = pointerName
      if (!existing.department && pointerRole) patch.department = pointerRole
      if (Object.keys(patch).length > 0) {
        patch.updatedAt = now
        await db.update(prospects).set(patch).where(eq(prospects.id, existing.id))
      }
      return { id: existing.id, name: existing.name, action: 'matched_existing' }
    }

    return await createDerivedProspect(db, tenantId, { ...referring, id: referring.id }, {
      name: pointerName,
      email: pointerEmail,
      role: pointerRole,
    }, now)
  }

  // pointer.email absent — can only update an existing same-org match; cannot
  // create because the schema requires at least one contact channel.
  const [existing] = await db
    .select({
      id: prospects.id,
      name: prospects.name,
      department: prospects.department,
      doNotContact: prospects.doNotContact,
    })
    .from(prospects)
    .where(
      and(
        eq(prospects.tenantId, tenantId),
        eq(prospects.organizationId, referring.organizationId),
        ilike(prospects.contactName, pointerName!),
      ),
    )
    .limit(1)

  if (!existing) return null
  if (existing.doNotContact) return null
  if (!existing.department && pointerRole) {
    await db.update(prospects).set({ department: pointerRole, updatedAt: now }).where(eq(prospects.id, existing.id))
  }
  return { id: existing.id, name: existing.name, action: 'matched_existing' }
}

// Prefer pointer.name; fall back to "Role (Referrer)" for context; finally
// the email if no name material is available.
function derivedDisplayName(
  pointer: { name: string | null; email: string; role: string | null },
  referringName: string,
): string {
  if (pointer.name) return pointer.name
  if (pointer.role) return `${pointer.role} (${referringName})`
  return pointer.email
}

async function createDerivedProspect(
  db: Db,
  tenantId: TenantId,
  referring: {
    id: number
    name: string
    organizationId: number
    overview: string
    websiteUrl: string
    industry: string | null
  },
  pointer: { name: string | null; email: string; role: string | null },
  now: Date,
): Promise<DerivedProspect> {
  const dateStr = now.toISOString().slice(0, 10)
  const [created] = await db
    .insert(prospects)
    .values({
      tenantId,
      name: derivedDisplayName(pointer, referring.name),
      contactName: pointer.name,
      organizationId: referring.organizationId,
      department: pointer.role,
      overview: referring.overview,
      industry: referring.industry,
      websiteUrl: referring.websiteUrl,
      email: pointer.email,
      notes: `Auto-created from decision-maker referral by ${referring.name} on ${dateStr}`,
      doNotContact: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: prospects.id, name: prospects.name })

  if (!created) throw new Error('Failed to insert derived prospect')

  const refLinks = await db
    .select({ projectId: projectProspects.projectId, priority: projectProspects.priority })
    .from(projectProspects)
    .where(and(eq(projectProspects.tenantId, tenantId), eq(projectProspects.prospectId, referring.id)))

  if (refLinks.length > 0) {
    await db.insert(projectProspects).values(
      refLinks.map((link) => projectProspectInsertValues({
        tenantId,
        projectId: link.projectId as ProjectId,
        prospectId: created.id,
        matchReason: `Decision-maker referral from ${referring.name}`,
        priority: link.priority,
        now,
      })),
    )
  }

  return { id: created.id, name: created.name, action: 'created' }
}

export type ListedResponse = {
  id: number
  channel: Channel
  content: string
  sentiment: (typeof sentimentEnum.enumValues)[number]
  responseType: (typeof responseTypeEnum.enumValues)[number]
  receivedAt: Date
  rejectionFeedback: RejectionFeedbackV1 | null
  prospectId: number
  prospectName: string
  outreachSubject: string | null
}

export async function listProjectResponses(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: ListResponsesQuery,
): Promise<ServiceResult<{ responses: ListedResponse[]; total: number }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const { limit, offset, sentiment, responseType } = query

  const conditions = [eq(outreachLogs.projectId, projectId)]
  if (sentiment) conditions.push(eq(responses.sentiment, sentiment))
  if (responseType) conditions.push(eq(responses.responseType, responseType))

  const where = and(...conditions)

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: responses.id,
        channel: responses.channel,
        content: responses.content,
        sentiment: responses.sentiment,
        responseType: responses.responseType,
        receivedAt: responses.receivedAt,
        rejectionFeedback: responses.rejectionFeedback,
        prospectId: outreachLogs.prospectId,
        prospectName: prospects.name,
        outreachSubject: outreachLogs.subject,
      })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(where)
      .orderBy(desc(responses.receivedAt), desc(responses.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(where),
  ])

  return ok({ responses: rows, total: countRows[0]?.total ?? 0 })
}

// `scope` filters which queries fire: 'pmf' skips recontact/decision-maker/
// not-relevant, 'tactical' skips feature_gap, 'all' runs them all.

export type RecontactSample = {
  receivedAt: Date
  prospectId: number
  prospectName: string
  organizationName: string
}

export type RecontactWindowBucket = {
  count: number
  samples: RecontactSample[]
}

export type RejectionFeedbackSummary = {
  windowDays: number | null
  scope: RejectionScope
  total: number
  primaryReasonDistribution: Array<{ reason: string; count: number; percentage: number }>
  featureGapNotes: Array<{
    receivedAt: Date
    freeText: string | null
    prospectId: number
    prospectName: string
    organizationName: string
  }>
  // Every bucket always present (empty: { count: 0, samples: [] }) so callers
  // iterate the five enum keys without optional-checks.
  recontactWindows: Record<RejectionRecontactWindow, RecontactWindowBucket>
  decisionMakerPointers: Array<{
    receivedAt: Date
    prospectId: number
    prospectName: string
    organizationName: string
    pointer: DecisionMakerPointer | null
  }>
  notRelevantNotes: Array<{
    receivedAt: Date
    freeText: string | null
    prospectId: number
    prospectName: string
    organizationName: string
    industry: string | null
  }>
}

function emptyRecontactWindows(): Record<RejectionRecontactWindow, RecontactWindowBucket> {
  const buckets = {} as Record<RejectionRecontactWindow, RecontactWindowBucket>
  for (const w of REJECTION_RECONTACT_WINDOWS) {
    buckets[w] = { count: 0, samples: [] }
  }
  return buckets
}

type RecontactRawRow = {
  window: RejectionRecontactWindow
  received_at: Date
  prospect_id: number
  prospect_name: string
  organization_name: string
  bucket_count: number
}

function bucketRecontactRows(
  rows: RecontactRawRow[] | null,
): Record<RejectionRecontactWindow, RecontactWindowBucket> {
  const buckets = emptyRecontactWindows()
  if (!rows) return buckets
  for (const r of rows) {
    const bucket = buckets[r.window]
    // bucket_count is identical across every row in the partition.
    bucket.count = r.bucket_count
    bucket.samples.push({
      receivedAt: r.received_at,
      prospectId: r.prospect_id,
      prospectName: r.prospect_name,
      organizationName: r.organization_name,
    })
  }
  return buckets
}

export async function getRejectionFeedbackSummary(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: RejectionFeedbackSummaryQuery,
): Promise<ServiceResult<RejectionFeedbackSummary>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const { scope, freeTextLimit, recontactLimit, notRelevantLimit } = query
  const windowDays = query.windowDays ?? null

  const since = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    : null

  const pmfReasonList = sql.join(
    PMF_RELEVANT_REASONS.map((r) => sql`${r}`),
    sql`, `,
  )

  const baseConditions = [
    eq(responses.tenantId, tenantId),
    eq(outreachLogs.projectId, projectId),
    eq(responses.responseType, 'rejection'),
    isNotNull(responses.rejectionFeedback),
  ]
  if (since) baseConditions.push(gte(responses.receivedAt, since))
  if (scope === 'pmf') {
    baseConditions.push(sql`${responses.rejectionFeedback}->>'primary_reason' IN (${pmfReasonList})`)
  } else if (scope === 'tactical') {
    baseConditions.push(sql`${responses.rejectionFeedback}->>'primary_reason' NOT IN (${pmfReasonList})`)
  }

  const recontactWindowList = sql.join(
    REJECTION_RECONTACT_WINDOWS.map((w) => sql`${w}`),
    sql`, `,
  )

  // Queries irrelevant to the requested scope are gated to null.
  const [reasonRows, featureGapRows, recontactRows, decisionMakerRows, notRelevantRows] = await Promise.all([
    db
      .select({
        reason: sql<string>`${responses.rejectionFeedback}->>'primary_reason'`,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(...baseConditions))
      .groupBy(sql`${responses.rejectionFeedback}->>'primary_reason'`),

    gated(scope !== 'tactical', () =>
      db
        .select({
          receivedAt: responses.receivedAt,
          freeText: sql<string | null>`${responses.rejectionFeedback}->>'free_text'`,
          prospectId: outreachLogs.prospectId,
          prospectName: prospects.name,
          organizationName: organizations.name,
        })
        .from(responses)
        .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
        .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
        .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
        .where(and(
          ...baseConditions,
          sql`${responses.rejectionFeedback}->>'primary_reason' = ${FEATURE_GAP_REASON}`,
        ))
        .orderBy(desc(responses.receivedAt))
        .limit(freeTextLimit),
    ),

    // Per-bucket top-N via PARTITION BY window. Without it, a popular window
    // crowds the others out of the sample set. bucket_count carries the
    // per-window total so callers see "N of M" without a second pass.
    // Filtered to REJECTION_RECONTACT_WINDOWS to drop junk/future-enum values.
    gated(scope !== 'pmf', () =>
      db.execute<{
        window: RejectionRecontactWindow
        received_at: Date
        prospect_id: number
        prospect_name: string
        organization_name: string
        bucket_count: number
      }>(sql`
        WITH ranked AS (
          SELECT
            -- "window" is a reserved keyword; quoted so the outer SELECT/ORDER BY parse.
            ${responses.rejectionFeedback}->>'preferred_recontact_window' AS "window",
            ${responses.receivedAt} AS received_at,
            ${outreachLogs.prospectId} AS prospect_id,
            ${prospects.name} AS prospect_name,
            ${organizations.name} AS organization_name,
            ROW_NUMBER() OVER (
              PARTITION BY ${responses.rejectionFeedback}->>'preferred_recontact_window'
              ORDER BY ${responses.receivedAt} DESC
            ) AS rn,
            COUNT(*) OVER (
              PARTITION BY ${responses.rejectionFeedback}->>'preferred_recontact_window'
            )::int AS bucket_count
          FROM ${responses}
          INNER JOIN ${outreachLogs} ON ${outreachLogs.id} = ${responses.outreachLogId}
          INNER JOIN ${prospects} ON ${prospects.id} = ${outreachLogs.prospectId}
          INNER JOIN ${organizations} ON ${organizations.id} = ${prospects.organizationId}
          WHERE ${and(
            ...baseConditions,
            sql`${responses.rejectionFeedback}->>'preferred_recontact_window' IN (${recontactWindowList})`,
          )}
        )
        SELECT "window", received_at, prospect_id, prospect_name, organization_name, bucket_count
        FROM ranked
        WHERE rn <= ${recontactLimit}
        ORDER BY "window", received_at DESC
      `),
    ),

    gated(scope !== 'pmf', () =>
      db
        .select({
          receivedAt: responses.receivedAt,
          prospectId: outreachLogs.prospectId,
          prospectName: prospects.name,
          organizationName: organizations.name,
          pointer: sql<DecisionMakerPointer | null>`${responses.rejectionFeedback}->'decision_maker_pointer'`,
        })
        .from(responses)
        .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
        .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
        .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
        .where(and(
          ...baseConditions,
          sql`${responses.rejectionFeedback}->'decision_maker_pointer' IS NOT NULL`,
        ))
        .orderBy(desc(responses.receivedAt))
        .limit(DECISION_MAKER_LIMIT),
    ),

    gated(scope !== 'pmf', () =>
      db
        .select({
          receivedAt: responses.receivedAt,
          freeText: sql<string | null>`${responses.rejectionFeedback}->>'free_text'`,
          prospectId: outreachLogs.prospectId,
          prospectName: prospects.name,
          organizationName: organizations.name,
          industry: prospects.industry,
        })
        .from(responses)
        .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
        .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
        .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
        .where(and(
          ...baseConditions,
          sql`${responses.rejectionFeedback}->>'primary_reason' = ${NOT_RELEVANT_REASON}`,
        ))
        .orderBy(desc(responses.receivedAt))
        .limit(notRelevantLimit),
    ),
  ])

  const total = reasonRows.reduce((sum, r) => sum + r.count, 0)

  return ok({
    windowDays,
    scope,
    total,
    primaryReasonDistribution: reasonRows
      .map((r) => ({
        reason: r.reason,
        count: r.count,
        percentage: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.count - a.count),
    featureGapNotes: (featureGapRows ?? []).map((r) => ({
      receivedAt: r.receivedAt,
      freeText: r.freeText,
      prospectId: r.prospectId,
      prospectName: r.prospectName,
      organizationName: r.organizationName,
    })),
    recontactWindows: bucketRecontactRows(recontactRows),
    decisionMakerPointers: (decisionMakerRows ?? []).map((r) => ({
      receivedAt: r.receivedAt,
      prospectId: r.prospectId,
      prospectName: r.prospectName,
      organizationName: r.organizationName,
      pointer: r.pointer,
    })),
    notRelevantNotes: (notRelevantRows ?? []).map((r) => ({
      receivedAt: r.receivedAt,
      freeText: r.freeText,
      prospectId: r.prospectId,
      prospectName: r.prospectName,
      organizationName: r.organizationName,
      industry: r.industry,
    })),
  })
}
