import { z } from 'zod'
import { eq, and, desc, sql, inArray, notInArray } from 'drizzle-orm'
import {
  outreachLogs,
  organizations,
  projectProspects,
  prospects,
  responses,
  channelEnum,
  skipReasonEnum,
  inquirySessions,
  inquiryOutcomeEnum,
  meetingRequestSourceEnum,
  REACHABLE_STATUSES,
  IN_FLIGHT_OUTREACH_STATUSES,
  type Channel,
  type OutreachStatus,
  type SnsAccounts,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  outreachLogIdSchema,
  projectIdSchema,
  prospectIdSchema,
  type ProjectId,
  type TenantId,
} from '../domain/ids'
export { outreachLogIdParamSchema } from '../domain/ids'
import {
  getRemainingOutreachQuota,
  outreachQuotaErrorIfExhausted,
} from './plan-limits'
import {
  sendGmailForUser,
  buildComplianceAttachments,
} from '../auth/google'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'
import { requireProspect } from './prospects'
import { allocateInquiryUrl } from './inquiry-token'
import { loadProjectReapproachSettings, loadProjectSendSettings } from './project-settings'
import { assertTenantComplianceReady } from './tenants'
import { addDays } from '../domain/prospect-status'
import { isAllowedSendCountry } from '../domain/country'
import { buildSkipAuditBody } from '../domain/outreach-skip'
import type { Edition } from '../domain/edition'

export const recentOutreachQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type RecentOutreachQuery = z.infer<typeof recentOutreachQuerySchema>

export const listDraftsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})
export type ListDraftsQuery = z.infer<typeof listDraftsQuerySchema>

// 'pre_send' is owned by recordOutreachWithInquiry / updateOutreachStatus —
// never a valid input here. sent_at is server-stamped: accepting it from the
// caller would let an authenticated user backdate a row past the daily/monthly
// quota window (`sent_at >= window_start`), bypassing the cap. `.strict()` makes
// the refusal explicit instead of silently dropping unknown keys.
// Discriminated by status so the type system enforces "errorMessage required
// iff status='failed'". Mirrors updateOutreachStatusSchema.
const recordOutreachCommonFields = {
  projectId: projectIdSchema,
  prospectId: prospectIdSchema,
  channel: z.enum(channelEnum.enumValues),
  subject: z.string().optional(),
  body: z.string().min(1),
} as const

export const recordOutreachSchema = z.discriminatedUnion('status', [
  z.object({
    ...recordOutreachCommonFields,
    status: z.literal('sent'),
  }).strict(),
  z.object({
    ...recordOutreachCommonFields,
    status: z.literal('failed'),
    errorMessage: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    ...recordOutreachCommonFields,
    status: z.literal('pending_review'),
  }).strict(),
])
export type RecordOutreachInput = z.infer<typeof recordOutreachSchema>

// A deliberate skip is distinct from a 'sent' or 'failed' outreach: no send is
// attempted. `reason` is the structured skip_reason; `channel` is the channel
// the run was about to use (kept for the audit feed, not a send target);
// `note` is optional free-text context. `.strict()` rejects stray keys.
export const skipProspectSchema = z
  .object({
    projectId: projectIdSchema,
    prospectId: prospectIdSchema,
    channel: z.enum(channelEnum.enumValues),
    reason: z.enum(skipReasonEnum.enumValues),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict()
export type SkipProspectInput = z.infer<typeof skipProspectSchema>

export const sendAndRecordSchema = z
  .object({
    projectId: projectIdSchema,
    prospectId: prospectIdSchema,
    to: z.array(z.email()).min(1),
    cc: z.array(z.email()).optional(),
    bcc: z.array(z.email()).optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    inReplyTo: z
      .string()
      .regex(/^<[^\r\n<>]+>$/, 'inReplyTo must be a single RFC 5322 Message-ID like <id@host>')
      .max(998)
      .optional(),
    // Optional explicit subject-variant id. When omitted or unknown/archived,
    // the server falls back to round-robin across the project's active variants.
    variantId: z.string().min(1).max(32).optional(),
  })
  .strict()
export type SendAndRecordInput = z.infer<typeof sendAndRecordSchema>

export const editDraftSchema = z
  .object({
    subject: z.string().nullable().optional(),
    body: z.string().min(1).optional(),
  })
  .strict()
export type EditDraftPatch = z.infer<typeof editDraftSchema>

// Skill-driven channels (form / SNS DM): the skill calls this BEFORE submit so
// the inquiry URL footer is allocated against a real outreach_log row
// (pre_send), then submits the returned finalBody. On success it calls
// updateOutreachStatus('sent'); on failure ('failed'). Prospect flips to
// 'contacted' only on the 'sent' transition.
//
// `body` in DB diverges by status:
//   - pre_send: core text only (the skill already has finalBody from the response).
//   - pending_review: footer-bearing finalBody, because the user copy-pastes
//     the row body from /drafts and there's no send-time hook to append the
//     footer like email's gmail.send. Storing core only would silently strip
//     the inquiry URL from manually-submitted form/SNS messages.
export const recordOutreachWithInquirySchema = z
  .object({
    projectId: projectIdSchema,
    prospectId: prospectIdSchema,
    channel: z.enum(['form', 'sns_twitter', 'sns_linkedin']),
    subject: z.string().optional(),
    body: z.string().min(1),
  })
  .strict()
export type RecordOutreachWithInquiryInput = z.infer<typeof recordOutreachWithInquirySchema>

// Only 'pre_send' → 'sent' / 'failed' transitions are accepted; enforced by the
// WHERE clause in updateOutreachStatus.
export const updateOutreachStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('sent') }).strict(),
  z
    .object({
      status: z.literal('failed'),
      errorMessage: z.string().min(1).max(2000),
    })
    .strict(),
])
export type UpdateOutreachStatusInput = z.infer<typeof updateOutreachStatusSchema>

export type SendContext = {
  userId: string
  encryptionKey: string
  clientId: string
  clientSecret: string
  appUrl: string
  apiUrl: string
  unsubscribeSecret: string
  // E2E redirect; see `sendGmailForUser`. Null in production.
  e2eRecipientOverride: string | null
}

// Compliance rules ship for US + CA + JP only; other jurisdictions blocked.
// Reads prospect.country first (per-prospect override for distributed teams /
// regional reps), falls back to organization.country. NULL is warn-only so the
// send proceeds and the warn surfaces in observability for backfill.
async function assertProspectCountryAllowed(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<ServiceResult<undefined>> {
  const [row] = await db
    .select({
      prospectCountry: prospects.country,
      organizationCountry: organizations.country,
    })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)

  // Missing prospect is the caller's bug, not a compliance refusal — let
  // the surrounding flow surface NOT_FOUND from its own lookup.
  if (!row) return ok(undefined)

  const effective = row.prospectCountry ?? row.organizationCountry
  const gate = isAllowedSendCountry(effective)
  if (!gate.allowed) {
    return err(
      'UNPROCESSABLE',
      `Recipient country ${gate.country} is not supported`,
      'LeadAce currently sends to US, CA, and JP only. Update the prospect or organization country, or skip this prospect.',
      { country: gate.country },
    )
  }
  if (gate.reason === 'unknown_warn') {
    console.warn(
      `[country-guardrail] tenant=${tenantId} prospectId=${prospectId} country=null — sending without country verification`,
    )
  }
  return ok(undefined)
}

export async function recordOutreach(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  input: RecordOutreachInput,
): Promise<ServiceResult<{ id: number | undefined }>> {
  // Compliance/quota/country only matter on actual delivery; drafts and failure
  // stamps must remain recordable on incomplete tenants so failed-send logs
  // aren't lost.
  const sending = input.status === 'sent'
  const [guard, prospectGuard, quota, compliance] = await Promise.all([
    requireProject(db, input.projectId, tenantId),
    requireProspect(db, tenantId, input.prospectId),
    sending ? getRemainingOutreachQuota(db, tenantId, edition) : Promise.resolve(null),
    sending ? assertTenantComplianceReady(db, tenantId) : Promise.resolve(null),
  ])
  if (!guard.ok) return guard
  if (!prospectGuard.ok) return prospectGuard
  if (compliance && !compliance.ok) return compliance
  const quotaErr = quota ? outreachQuotaErrorIfExhausted(quota) : null
  if (quotaErr) return quotaErr

  if (sending) {
    const country = await assertProspectCountryAllowed(db, tenantId, input.prospectId)
    if (!country.ok) return country
  }

  const sentAt = new Date()

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId: input.projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      status: input.status,
      sentAt,
      errorMessage: input.status === 'failed' ? input.errorMessage : null,
    })
    .returning({ id: outreachLogs.id })

  // Drafts (pending_review) intentionally leave the prospect reachable;
  // listReachable excludes them via a separate NOT EXISTS so the status
  // keeps its real-world meaning.
  if (input.status === 'sent' && log) {
    await markProspectContacted(db, input.projectId, input.prospectId, sentAt)
  } else if (input.status === 'failed' && log) {
    await deferProspectReeligibility(db, input.projectId, input.prospectId, sentAt)
  }

  return ok({ id: log?.id as number | undefined })
}

// Record a deliberate skip: an outbound run decided NOT to contact this
// prospect (no send attempted) for an LLM-judged reason the server cannot
// determine itself — bad timing or no fresh re-approach material. Writes a
// 'skipped' audit row and defers re-eligibility by noResponseRecycleDays so
// the prospect drops out of get_outbound_targets for that window. No quota is
// consumed (only 'sent' counts) and the prospect is NOT flipped to
// 'contacted'. Replaces the old pattern of fabricating a 'failed' row.
export async function skipProspect(
  db: Db,
  tenantId: TenantId,
  input: SkipProspectInput,
): Promise<ServiceResult<{ id: number | undefined }>> {
  const [guard, prospectGuard] = await Promise.all([
    requireProject(db, input.projectId, tenantId),
    requireProspect(db, tenantId, input.prospectId),
  ])
  if (!guard.ok) return guard
  if (!prospectGuard.ok) return prospectGuard

  const sentAt = new Date()

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId: input.projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      // body carries the human-readable skip line (incl. the note); skipReason
      // is the structured reason. errorMessage stays NULL — a deliberate skip
      // is not an error, and the recent-outreach feed renders errorMessage as
      // a red "Error:" line.
      body: buildSkipAuditBody(input.reason, input.note),
      status: 'skipped',
      skipReason: input.reason,
      sentAt,
    })
    .returning({ id: outreachLogs.id })

  if (log) {
    await deferProspectReeligibility(db, input.projectId, input.prospectId, sentAt)
  }

  return ok({ id: log?.id as number | undefined })
}

// Send mode: row starts as 'pre_send' (in-flight reservation — counts toward
// quota so concurrent allocations can't race past the cap, excluded from
// listReachable, but prospect NOT yet flipped to 'contacted'). The flip happens
// only on the 'sent' transition in updateOutreachStatus.
// Draft mode: row starts as 'pending_review'; markDraftSent flips at confirm.
export type RecordOutreachWithInquiryResult = {
  outreachLogId: number
  status: 'pre_send' | 'pending_review'
  finalBody: string
  inquiryUrl: string | null
}

export async function recordOutreachWithInquiry(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  ctx: SendContext,
  input: RecordOutreachWithInquiryInput,
): Promise<ServiceResult<RecordOutreachWithInquiryResult>> {
  // Gate project existence before loadProjectSendSettings, which asserts the
  // settings row exists — loading it for a missing project would 500 not 404.
  const guard = await requireProject(db, input.projectId, tenantId)
  if (!guard.ok) return guard
  const [prospectGuard, sendSettings, complianceResult] = await Promise.all([
    requireProspect(db, tenantId, input.prospectId),
    loadProjectSendSettings(db, input.projectId),
    assertTenantComplianceReady(db, tenantId),
  ])
  if (!prospectGuard.ok) return prospectGuard
  if (!complianceResult.ok) return complianceResult

  const willSend = sendSettings.outboundMode === 'send'

  if (willSend) {
    const quota = await getRemainingOutreachQuota(db, tenantId, edition)
    const quotaErr = outreachQuotaErrorIfExhausted(quota)
    if (quotaErr) return quotaErr
    const country = await assertProspectCountryAllowed(db, tenantId, input.prospectId)
    if (!country.ok) return country
  }

  const sentAt = new Date()
  const status: OutreachStatus = willSend ? 'pre_send' : 'pending_review'

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId: input.projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      status,
      sentAt,
    })
    .returning({ id: outreachLogs.id })

  if (!log) return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')

  const inquiryUrl = await allocateInquiryUrl(
    db,
    tenantId,
    ctx.appUrl,
    log.id,
    sendSettings.inquiryLandingEnabled,
  )

  const compliance = complianceResult.value
  const attachments = await buildComplianceAttachments({
    prospectId: input.prospectId,
    tenantId,
    inquiryUrl,
    appUrl: ctx.appUrl,
    apiUrl: ctx.apiUrl,
    secret: ctx.unsubscribeSecret,
    tenantLegalName: compliance.legalName,
    tenantPhysicalAddress: compliance.physicalAddress,
    tenantPrivacyPolicyUrl: compliance.privacyPolicyUrl,
  })
  const finalBody = `${input.body}${attachments.footer}`

  // pending_review (form/SNS draft) is copy-pasted by the user from /drafts —
  // no send-time hook to append the footer like email's gmail.send. Persist
  // finalBody so the inquiry URL / compliance footer survive the copy-paste.
  if (status === 'pending_review') {
    await db.update(outreachLogs).set({ body: finalBody }).where(eq(outreachLogs.id, log.id))
  }

  return ok({
    outreachLogId: log.id,
    status,
    finalBody,
    inquiryUrl,
  })
}

// Resolves a 'pre_send' allocation. status='sent' flips the prospect to
// 'contacted'; 'failed' refunds the in-flight quota reservation and stamps the
// recycle window onto next_outreach_after. Restricted to the 'pre_send' →
// terminal transition so callers can't repurpose this for arbitrary flips.
export async function updateOutreachStatus(
  db: Db,
  tenantId: TenantId,
  id: number,
  input: UpdateOutreachStatusInput,
): Promise<ServiceResult<{ id: number }>> {
  // sentAt stays at pre_send allocation time: quota windows key off sent_at
  // and the cap check ran against that timestamp at allocation. Re-anchoring
  // to confirm time would let a 23:55 reservation confirmed at 00:05 hop into
  // the next day's bucket after the cap check already passed.
  const [updated] = await db
    .update(outreachLogs)
    .set({
      status: input.status,
      errorMessage: input.status === 'failed' ? input.errorMessage : null,
    })
    .where(and(
      eq(outreachLogs.id, id),
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.status, 'pre_send'),
    ))
    .returning({
      id: outreachLogs.id,
      projectId: outreachLogs.projectId,
      prospectId: outreachLogs.prospectId,
      sentAt: outreachLogs.sentAt,
    })

  if (!updated) {
    return err('NOT_FOUND', 'Outreach not found or not in "pre_send" state')
  }

  if (input.status === 'sent') {
    await markProspectContacted(db, updated.projectId as ProjectId, updated.prospectId, updated.sentAt)
  } else if (input.status === 'failed') {
    await deferProspectReeligibility(db, updated.projectId as ProjectId, updated.prospectId, updated.sentAt)
  }

  return ok({ id: updated.id })
}

// Branches on the project's outboundMode (loaded server-side, never passed by
// the caller) so the mode decision is deterministic and lives here, not in
// skill logic. `send` calls Gmail and writes sent/failed; `draft` writes
// pending_review for the user to review and send from the web app.
export type SendOutcome =
  | { mode: 'sent'; outreachId: number; messageId: string; threadId: string }
  | { mode: 'drafted'; outreachId: number }

export async function sendAndRecord(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  ctx: SendContext,
  input: SendAndRecordInput,
): Promise<ServiceResult<SendOutcome>> {
  // Gate project existence before loadProjectSendSettings, which asserts the
  // settings row exists — loading it for a missing project would 500 not 404.
  const guard = await requireProject(db, input.projectId, tenantId)
  if (!guard.ok) return guard
  const [prospectGuard, sendSettings, complianceResult] = await Promise.all([
    requireProspect(db, tenantId, input.prospectId),
    loadProjectSendSettings(db, input.projectId),
    assertTenantComplianceReady(db, tenantId),
  ])
  if (!prospectGuard.ok) return prospectGuard
  // Compliance must gate both branches: even in draft mode the user clicks
  // "send from /drafts" later, and we want the 412 to surface at allocation
  // (skill, /outbound report) rather than at confirm time after the body's
  // already been composed.
  if (!complianceResult.ok) return complianceResult
  if (sendSettings.outboundMode === 'draft') {
    const sentAt = new Date()
    const [log] = await db
      .insert(outreachLogs)
      .values({
        tenantId,
        projectId: input.projectId,
        prospectId: input.prospectId,
        channel: 'email',
        subject: input.subject,
        body: input.body,
        status: 'pending_review',
        sentAt,
        variantId: input.variantId ?? null,
      })
      .returning({ id: outreachLogs.id })

    if (!log) return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')
    return ok({ mode: 'drafted', outreachId: log.id })
  }

  const compliance = complianceResult.value

  const quota = await getRemainingOutreachQuota(db, tenantId, edition)
  const quotaErr = outreachQuotaErrorIfExhausted(quota)
  if (quotaErr) return quotaErr

  const country = await assertProspectCountryAllowed(db, tenantId, input.prospectId)
  if (!country.ok) return country

  // INSERT as 'pre_send' so the row counts toward quota (preventing concurrent
  // allocations from racing past the cap) and gives createInquiryToken's FK a
  // target. The whole flow runs inside the rlsMiddleware transaction, so an
  // exception before the response rolls everything back.
  const sentAt = new Date()
  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId: input.projectId,
      prospectId: input.prospectId,
      channel: 'email',
      subject: input.subject,
      body: input.body,
      status: 'pre_send',
      sentAt,
      variantId: input.variantId ?? null,
    })
    .returning({ id: outreachLogs.id })

  if (!log) {
    return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')
  }

  const inquiryUrl = await allocateInquiryUrl(
    db,
    tenantId,
    ctx.appUrl,
    log.id,
    sendSettings.inquiryLandingEnabled,
  )

  const attachments = await buildComplianceAttachments({
    prospectId: input.prospectId,
    tenantId,
    inquiryUrl,
    appUrl: ctx.appUrl,
    apiUrl: ctx.apiUrl,
    secret: ctx.unsubscribeSecret,
    tenantLegalName: compliance.legalName,
    tenantPhysicalAddress: compliance.physicalAddress,
    tenantPrivacyPolicyUrl: compliance.privacyPolicyUrl,
  })
  const sendBody = `${input.body}${attachments.footer}`

  const result = await sendGmailForUser(db, {
    tenantId,
    userId: ctx.userId,
    encryptionKey: ctx.encryptionKey,
    clientId: ctx.clientId,
    clientSecret: ctx.clientSecret,
    to: input.to,
    cc: input.cc,
    bcc: input.bcc,
    subject: input.subject,
    body: sendBody,
    inReplyTo: input.inReplyTo,
    extraHeaders: attachments.headers,
    senderEmailAlias: sendSettings.senderEmailAlias,
    senderDisplayName: sendSettings.senderDisplayName,
    e2eRecipientOverride: ctx.e2eRecipientOverride,
  })

  if (!result.ok && result.httpStatus === 412) {
    // Configuration error (Gmail not connected / token revoked). Drop the
    // pre_send reservation so the user's quota isn't burned by a misconfig
    // they can fix and retry.
    await db.delete(outreachLogs).where(eq(outreachLogs.id, log.id))
    return err('PRECONDITION_FAILED', result.error, result.detail)
  }

  if (!result.ok) {
    await db
      .update(outreachLogs)
      .set({ status: 'failed', errorMessage: result.detail })
      .where(eq(outreachLogs.id, log.id))
    await deferProspectReeligibility(db, input.projectId, input.prospectId, sentAt)
    return err('BAD_GATEWAY', result.error, result.detail, { outreachId: log.id })
  }

  // sentAt stays at pre_send allocation time — see updateOutreachStatus.
  await db
    .update(outreachLogs)
    .set({ status: 'sent' })
    .where(eq(outreachLogs.id, log.id))
  await markProspectContacted(db, input.projectId, input.prospectId, sentAt)

  return ok({
    mode: 'sent',
    outreachId: log.id,
    messageId: result.messageId,
    threadId: result.threadId,
  })
}

export type RecentOutreachLog = {
  id: number
  prospectId: number
  prospectName: string
  contactName: string | null
  prospectEmail: string | null
  organizationDomain: string
  channel: Channel
  subject: string | null
  body: string
  status: OutreachStatus
  sentAt: Date
  errorMessage: string | null
  responseCount: number
  latestResponseAt: string | null
  // Most-significant outcome ever recorded
  // (lead > signup_clicked > unsubscribed > inquired > opened), independent
  // of revisit order. signup_clicked appears only in inquiryCtaType='signup'.
  inquirySessionCount: number
  inquiryOutcome: (typeof inquiryOutcomeEnum.enumValues)[number] | null
  inquiryMeetingSource: (typeof meetingRequestSourceEnum.enumValues)[number] | null
  inquiryLastVisitAt: string | null
}

export async function listRecentOutreach(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: RecentOutreachQuery,
): Promise<ServiceResult<{ logs: RecentOutreachLog[]; total: number }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const { limit, offset } = query

  const visibleStatusFilter = and(
    eq(outreachLogs.projectId, projectId),
    // Confirmed events belong in the recent activity feed (sent / failed /
    // skipped); in-flight allocations (pending_review / pre_send) do not.
    // Spread because notInArray's typing rejects readonly inputs.
    notInArray(outreachLogs.status, [...IN_FLIGHT_OUTREACH_STATUSES]),
  )

  const [logs, countRows] = await Promise.all([
    db
      .select({
        id: outreachLogs.id,
        prospectId: outreachLogs.prospectId,
        prospectName: prospects.name,
        contactName: prospects.contactName,
        prospectEmail: prospects.email,
        organizationDomain: organizations.domain,
        channel: outreachLogs.channel,
        subject: outreachLogs.subject,
        body: outreachLogs.body,
        status: outreachLogs.status,
        sentAt: outreachLogs.sentAt,
        errorMessage: outreachLogs.errorMessage,
        responseCount: sql<number>`COALESCE(COUNT(${responses.id})::int, 0)`,
        latestResponseAt: sql<string | null>`MAX(${responses.receivedAt})`,
      })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
      .where(visibleStatusFilter)
      .groupBy(outreachLogs.id, prospects.id, organizations.id)
      .orderBy(desc(outreachLogs.sentAt), desc(outreachLogs.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(outreachLogs)
      .where(visibleStatusFilter),
  ])

  // `bestOutcome` is the highest-severity outcome ever reached, not the
  // chronologically latest. A recipient who converts ('lead') and later
  // re-visits opens a fresh outcome='opened' row; the lead callout / draft-skip
  // rules must still see the confirmed lead.
  const outreachIds = logs.map((l) => l.id)
  type InquiryOutcomeT = (typeof inquiryOutcomeEnum.enumValues)[number]
  type MeetingSourceT = (typeof meetingRequestSourceEnum.enumValues)[number] | null
  const OUTCOME_PRIORITY: Record<InquiryOutcomeT, number> = {
    opened: 1,
    inquired: 2,
    unsubscribed: 3,
    signup_clicked: 4,
    lead: 5,
  }
  const aggregates = new Map<
    number,
    {
      count: number
      bestOutcome: InquiryOutcomeT
      bestSource: MeetingSourceT
      lastVisitAt: Date
    }
  >()
  if (outreachIds.length > 0) {
    const sessions = await db
      .select({
        outreachLogId: inquirySessions.outreachLogId,
        outcome: inquirySessions.outcome,
        meetingRequestSource: inquirySessions.meetingRequestSource,
        openedAt: inquirySessions.openedAt,
      })
      .from(inquirySessions)
      .where(inArray(inquirySessions.outreachLogId, outreachIds))
    for (const s of sessions) {
      const existing = aggregates.get(s.outreachLogId)
      if (!existing) {
        aggregates.set(s.outreachLogId, {
          count: 1,
          bestOutcome: s.outcome,
          bestSource: s.meetingRequestSource,
          lastVisitAt: s.openedAt,
        })
        continue
      }
      existing.count += 1
      if (OUTCOME_PRIORITY[s.outcome] > OUTCOME_PRIORITY[existing.bestOutcome]) {
        existing.bestOutcome = s.outcome
        existing.bestSource = s.meetingRequestSource
      }
      if (s.openedAt > existing.lastVisitAt) existing.lastVisitAt = s.openedAt
    }
  }

  const enriched: RecentOutreachLog[] = logs.map((l) => {
    const agg = aggregates.get(l.id)
    return {
      ...l,
      inquirySessionCount: agg?.count ?? 0,
      inquiryOutcome: agg?.bestOutcome ?? null,
      inquiryMeetingSource: agg?.bestSource ?? null,
      inquiryLastVisitAt: agg ? agg.lastVisitAt.toISOString() : null,
    }
  })

  return ok({ logs: enriched, total: countRows[0]?.total ?? 0 })
}

export type OutreachResponseRow = {
  id: number
  channel: string
  content: string
  sentiment: string
  responseType: string
  receivedAt: Date
}

export async function listOutreachResponses(
  db: Db,
  tenantId: TenantId,
  id: number,
): Promise<ServiceResult<{ responses: OutreachResponseRow[] }>> {
  const [log] = await db
    .select({ id: outreachLogs.id })
    .from(outreachLogs)
    .where(and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId)))
    .limit(1)

  if (!log) return err('NOT_FOUND', 'Outreach log not found')

  const rows = await db
    .select({
      id: responses.id,
      channel: responses.channel,
      content: responses.content,
      sentiment: responses.sentiment,
      responseType: responses.responseType,
      receivedAt: responses.receivedAt,
    })
    .from(responses)
    .where(eq(responses.outreachLogId, id))
    .orderBy(desc(responses.receivedAt))

  return ok({ responses: rows })
}

export type DraftRow = {
  id: number
  prospectId: number
  prospectName: string
  prospectEmail: string | null
  prospectContactFormUrl: string | null
  prospectSnsAccounts: SnsAccounts | null
  channel: Channel
  subject: string | null
  body: string
  createdAt: Date
}

export async function listDrafts(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: ListDraftsQuery,
): Promise<ServiceResult<{ drafts: DraftRow[]; total: number }>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const { limit, offset } = query

  const where = and(
    eq(outreachLogs.projectId, projectId),
    eq(outreachLogs.status, 'pending_review'),
  )

  const [drafts, countRows] = await Promise.all([
    db
      .select({
        id: outreachLogs.id,
        prospectId: outreachLogs.prospectId,
        prospectName: prospects.name,
        prospectEmail: prospects.email,
        prospectContactFormUrl: prospects.contactFormUrl,
        prospectSnsAccounts: prospects.snsAccounts,
        channel: outreachLogs.channel,
        subject: outreachLogs.subject,
        body: outreachLogs.body,
        createdAt: outreachLogs.sentAt,
      })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(where)
      .orderBy(desc(outreachLogs.sentAt), desc(outreachLogs.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(outreachLogs)
      .where(where),
  ])

  return ok({ drafts, total: countRows[0]?.total ?? 0 })
}

export async function editDraft(
  db: Db,
  tenantId: TenantId,
  id: number,
  patch: EditDraftPatch,
): Promise<ServiceResult<{ id: number }>> {
  const [updated] = await db
    .update(outreachLogs)
    .set({
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
    })
    .where(and(
      eq(outreachLogs.id, id),
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.status, 'pending_review'),
    ))
    .returning({ id: outreachLogs.id })

  if (!updated) {
    return err('NOT_FOUND', 'Draft not found or already sent')
  }
  return ok({ id: updated.id })
}

export async function sendDraft(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  ctx: SendContext,
  id: number,
): Promise<ServiceResult<SendOutcome>> {
  const [draft, quota] = await Promise.all([
    db
      .select({
        id: outreachLogs.id,
        projectId: outreachLogs.projectId,
        prospectId: outreachLogs.prospectId,
        channel: outreachLogs.channel,
        subject: outreachLogs.subject,
        body: outreachLogs.body,
        status: outreachLogs.status,
        prospectEmail: prospects.email,
        doNotContact: prospects.doNotContact,
      })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId)))
      .limit(1)
      .then((rows) => rows[0]),
    getRemainingOutreachQuota(db, tenantId, edition),
  ])

  if (!draft) return err('NOT_FOUND', 'Draft not found')
  if (draft.status !== 'pending_review') {
    return err('CONFLICT', 'Draft already sent or not in review')
  }
  if (draft.channel !== 'email') {
    return err('UNPROCESSABLE', 'This draft is not an email — use mark-sent instead')
  }
  if (!draft.prospectEmail) {
    return err('UNPROCESSABLE', 'Prospect has no email address')
  }
  if (draft.doNotContact) {
    return err('UNPROCESSABLE', 'Prospect is on do-not-contact list')
  }
  const quotaErr = outreachQuotaErrorIfExhausted(quota)
  if (quotaErr) return quotaErr

  const [sendSettings, complianceResult, countryResult] = await Promise.all([
    loadProjectSendSettings(db, draft.projectId as ProjectId),
    assertTenantComplianceReady(db, tenantId),
    assertProspectCountryAllowed(db, tenantId, draft.prospectId),
  ])
  if (!complianceResult.ok) return complianceResult
  if (!countryResult.ok) return countryResult
  const compliance = complianceResult.value

  const inquiryUrl = await allocateInquiryUrl(
    db,
    tenantId,
    ctx.appUrl,
    draft.id,
    sendSettings.inquiryLandingEnabled,
  )

  const attachments = await buildComplianceAttachments({
    prospectId: draft.prospectId,
    tenantId,
    inquiryUrl,
    appUrl: ctx.appUrl,
    apiUrl: ctx.apiUrl,
    secret: ctx.unsubscribeSecret,
    tenantLegalName: compliance.legalName,
    tenantPhysicalAddress: compliance.physicalAddress,
    tenantPrivacyPolicyUrl: compliance.privacyPolicyUrl,
  })
  const sendBody = `${draft.body}${attachments.footer}`

  const result = await sendGmailForUser(db, {
    tenantId,
    userId: ctx.userId,
    encryptionKey: ctx.encryptionKey,
    clientId: ctx.clientId,
    clientSecret: ctx.clientSecret,
    to: [draft.prospectEmail],
    subject: draft.subject ?? '',
    body: sendBody,
    extraHeaders: attachments.headers,
    senderEmailAlias: sendSettings.senderEmailAlias,
    senderDisplayName: sendSettings.senderDisplayName,
    e2eRecipientOverride: ctx.e2eRecipientOverride,
  })

  if (!result.ok && result.httpStatus === 412) {
    return err('PRECONDITION_FAILED', result.error, result.detail)
  }

  const sentAt = new Date()
  await db
    .update(outreachLogs)
    .set({
      status: result.ok ? 'sent' : 'failed',
      sentAt,
      errorMessage: result.ok ? null : result.detail,
    })
    .where(eq(outreachLogs.id, draft.id))

  if (!result.ok) {
    await deferProspectReeligibility(db, draft.projectId as ProjectId, draft.prospectId, sentAt)
    return err('BAD_GATEWAY', result.error, result.detail, { outreachId: draft.id })
  }

  await markProspectContacted(db, draft.projectId as ProjectId, draft.prospectId, sentAt)

  return ok({
    mode: 'sent',
    outreachId: draft.id,
    messageId: result.messageId,
    threadId: result.threadId,
  })
}

// For form / SNS drafts delivered outside our system (user submits manually).
// Email drafts must use /send (Gmail-backed) — this refuses channel=email so
// the two paths stay distinct in the UI.
export async function markDraftSent(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  id: number,
): Promise<ServiceResult<{ outreachId: number }>> {
  const [draft, quota] = await Promise.all([
    db
      .select({
        id: outreachLogs.id,
        projectId: outreachLogs.projectId,
        prospectId: outreachLogs.prospectId,
        channel: outreachLogs.channel,
        status: outreachLogs.status,
        doNotContact: prospects.doNotContact,
      })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId)))
      .limit(1)
      .then((rows) => rows[0]),
    getRemainingOutreachQuota(db, tenantId, edition),
  ])

  if (!draft) return err('NOT_FOUND', 'Draft not found')
  if (draft.status !== 'pending_review') {
    return err('CONFLICT', 'Draft already sent or not in review')
  }
  if (draft.channel === 'email') {
    return err('UNPROCESSABLE', 'Email drafts must be sent via /send, not mark-sent')
  }
  if (draft.doNotContact) {
    return err('UNPROCESSABLE', 'Prospect is on do-not-contact list')
  }
  const quotaErr = outreachQuotaErrorIfExhausted(quota)
  if (quotaErr) return quotaErr

  // Re-apply send guards at confirm time. The form/SNS draft path runs
  // compliance only at allocation and skips country in draft mode, so legacy /
  // out-of-band rows could otherwise be flipped to 'sent' against an
  // unsupported country or an incomplete tenant identity.
  const [complianceResult, countryResult] = await Promise.all([
    assertTenantComplianceReady(db, tenantId),
    assertProspectCountryAllowed(db, tenantId, draft.prospectId),
  ])
  if (!complianceResult.ok) return complianceResult
  if (!countryResult.ok) return countryResult

  const sentAt = new Date()
  await db
    .update(outreachLogs)
    .set({ status: 'sent', sentAt })
    .where(eq(outreachLogs.id, draft.id))

  await markProspectContacted(db, draft.projectId as ProjectId, draft.prospectId, sentAt)

  return ok({ outreachId: draft.id })
}

export async function discardDraft(
  db: Db,
  tenantId: TenantId,
  id: number,
): Promise<ServiceResult<{ deleted: true }>> {
  // Atomic delete-if-pending: avoids the read-then-delete race that would
  // let concurrent /send and /delete both succeed.
  const [deleted] = await db
    .delete(outreachLogs)
    .where(and(
      eq(outreachLogs.id, id),
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.status, 'pending_review'),
    ))
    .returning({ id: outreachLogs.id })

  if (!deleted) {
    const [exists] = await db
      .select({ status: outreachLogs.status })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId)))
      .limit(1)
    if (!exists) return err('NOT_FOUND', 'Draft not found')
    return err('CONFLICT', 'Cannot discard a sent or failed message')
  }

  return ok({ deleted: true })
}

// Two input modes:
//   { ids: [...] }            — explicit list (max 200)
//   { allInProjectId: "..." } — wipe every pending_review draft in a project
// Single SQL DELETE filters by tenant + pending_review; other-tenant or
// already-sent rows are silently excluded. `skippedIds` is populated only
// in explicit-id mode for caller-supplied ids that didn't match.
export const discardDraftsBodySchema = z
  .union([
    z.object({
      ids: z.array(outreachLogIdSchema).min(1).max(200),
    }).strict(),
    z.object({
      allInProjectId: projectIdSchema,
    }).strict(),
  ])
export type DiscardDraftsInput = z.infer<typeof discardDraftsBodySchema>

export async function discardDrafts(
  db: Db,
  tenantId: TenantId,
  input: DiscardDraftsInput,
): Promise<ServiceResult<{ deletedIds: number[]; skippedIds: number[] }>> {
  if ('allInProjectId' in input) {
    const guard = await requireProject(db, input.allInProjectId, tenantId)
    if (!guard.ok) return guard

    const deleted = await db
      .delete(outreachLogs)
      .where(and(
        eq(outreachLogs.projectId, input.allInProjectId),
        eq(outreachLogs.tenantId, tenantId),
        eq(outreachLogs.status, 'pending_review'),
      ))
      .returning({ id: outreachLogs.id })

    return ok({
      deletedIds: deleted.map((d) => d.id),
      skippedIds: [],
    })
  }

  const uniqueIds = [...new Set(input.ids)]

  const deleted = await db
    .delete(outreachLogs)
    .where(and(
      inArray(outreachLogs.id, uniqueIds),
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.status, 'pending_review'),
    ))
    .returning({ id: outreachLogs.id })

  const deletedIds = deleted.map((d) => d.id)
  const deletedSet = new Set<number>(deletedIds)
  const skippedIds = uniqueIds.filter((id) => !deletedSet.has(id))
  return ok({ deletedIds, skippedIds })
}

// Flip project_prospects to 'contacted' (from reachable) and advance
// prospects.next_outreach_after to `at + noResponseRecycleDays` via GREATEST.
// GREATEST is load-bearing: a re-approach send to a prospect whose
// next_outreach_after is already past would otherwise leave that past
// timestamp in place, and listReachable's contacted-with-elapsed-stamp branch
// would re-pick the prospect on the very next /outbound run. A longer
// explicit window (e.g. rejection feedback '12_months') is preserved.
async function markProspectContacted(
  db: Db,
  projectId: ProjectId,
  prospectId: number,
  at: Date,
): Promise<void> {
  const flipped = await db
    .update(projectProspects)
    .set({ status: 'contacted', updatedAt: at })
    .where(
      and(
        eq(projectProspects.projectId, projectId),
        eq(projectProspects.prospectId, prospectId),
        inArray(projectProspects.status, REACHABLE_STATUSES),
      ),
    )
    .returning({ id: projectProspects.id })

  if (flipped.length === 0) return

  const settings = await loadProjectReapproachSettings(db, projectId)
  const recycleAt = addDays(at, settings.noResponseRecycleDays)
  const recycleIso = recycleAt.toISOString()

  await db
    .update(prospects)
    .set({
      nextOutreachAfter: sql`GREATEST(${prospects.nextOutreachAfter}, ${recycleIso}::timestamptz)`,
      updatedAt: at,
    })
    .where(eq(prospects.id, prospectId))
}

// Defer a prospect's re-eligibility by noResponseRecycleDays so listReachable
// drops it for that window. Called after a real send failure AND after a
// deliberate skip_prospect (bad timing / no fresh material). Without the stamp
// the next /outbound run re-picks the prospect and the LLM burns context
// re-evaluating the same dead end. GREATEST preserves a longer explicit window
// (e.g. rejection '12_months').
async function deferProspectReeligibility(
  db: Db,
  projectId: ProjectId,
  prospectId: number,
  at: Date,
): Promise<void> {
  const settings = await loadProjectReapproachSettings(db, projectId)
  const recycleAt = addDays(at, settings.noResponseRecycleDays)
  const recycleIso = recycleAt.toISOString()

  await db
    .update(prospects)
    .set({
      nextOutreachAfter: sql`GREATEST(${prospects.nextOutreachAfter}, ${recycleIso}::timestamptz)`,
      updatedAt: at,
    })
    .where(eq(prospects.id, prospectId))
}

