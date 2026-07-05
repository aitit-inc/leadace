import { z } from 'zod'
import { eq, and, desc, sql, inArray, notInArray, isNotNull } from 'drizzle-orm'
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
  projectRefSchema,
  prospectIdSchema,
  variantIdSchema,
  type ProjectId,
  type ProjectRef,
  type SendingIdentityId,
  type TenantId,
} from '../domain/ids'
export { outreachLogIdParamSchema } from '../domain/ids'
import {
  getRemainingOutreachQuota,
  outreachQuotaErrorIfExhausted,
  getMailboxDailyQuota,
  mailboxQuotaErrorIfExhausted,
} from './plan-limits'
import {
  sendForIdentity,
  buildComplianceAttachments,
  resolveSendingIdentityId,
  stampMailboxFirstSendIfNeeded,
} from '../auth/google'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { UNDELIVERABLE } from '../domain/email-deliverability'
import { requireProspect, prospectHadFreshSignal } from './prospects'
import { allocateInquiryUrl } from './inquiry-token'
import { loadProjectReapproachSettings, loadProjectSendSettings, loadProjectFollowUpConfig } from './project-settings'
import {
  assertTenantComplianceReady,
  localizeComplianceIdentity,
  type TenantComplianceProjection,
} from './tenants'
import { addDays } from '../domain/prospect-status'
import { isAllowedSendCountry } from '../domain/country'
import type { Locale } from '../domain/locale'
import { buildSkipAuditBody } from '../domain/outreach-skip'
import { isPublicHttpsUrl } from '../domain/url'
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
const recordOutreachCommonFields = {
  projectId: projectRefSchema,
  prospectId: prospectIdSchema,
  channel: z.enum(channelEnum.enumValues),
  subject: z.string().optional(),
  body: z.string().min(1),
  variantId: variantIdSchema.optional(),
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

// No send is attempted on a skip; `channel` is the channel the run was about
// to use — kept for the audit feed, not a send target.
export const skipProspectSchema = z
  .object({
    projectId: projectRefSchema,
    prospectId: prospectIdSchema,
    channel: z.enum(channelEnum.enumValues),
    reason: z.enum(skipReasonEnum.enumValues),
    note: z.string().min(1).max(2000).optional(),
  })
  .strict()
export type SkipProspectInput = z.infer<typeof skipProspectSchema>

export const sendAndRecordSchema = z
  .object({
    projectId: projectRefSchema,
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
    // This path performs no variant selection — the weighted draw happens
    // upstream in pick_subject_variant.
    variantId: variantIdSchema.optional(),
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
// (pre_send), then submits the returned finalBody and confirms via
// updateOutreachStatus('sent' / 'failed').
export const recordOutreachWithInquirySchema = z
  .object({
    projectId: projectRefSchema,
    prospectId: prospectIdSchema,
    channel: z.enum(['form', 'sns_twitter', 'sns_linkedin']),
    subject: z.string().optional(),
    body: z.string().min(1),
    variantId: variantIdSchema.optional(),
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
  encryptionKey: string
  clientId: string
  clientSecret: string
  appUrl: string
  apiUrl: string
  unsubscribeSecret: string
  // E2E redirect; see `sendForIdentity`. Null in production.
  e2eRecipientOverride: string | null
}

// The prospect's country wins over the organization's: per-prospect override
// for distributed teams / regional reps.
async function loadEffectiveRecipientCountry(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<string | null> {
  const [row] = await db
    .select({
      prospectCountry: prospects.country,
      organizationCountry: organizations.country,
    })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)
  if (!row) return null
  return row.prospectCountry ?? row.organizationCountry
}

// Bypassed under E2E: sendForIdentity redirects every recipient to a test sink,
// so the localhost links a dev stack produces never reach a real inbox.
function assertPublicHttpsSendHosts(ctx: SendContext): ServiceResult<undefined> {
  if (ctx.e2eRecipientOverride) return ok(undefined)
  for (const [name, value] of [
    ['APP_URL', ctx.appUrl],
    ['API_URL', ctx.apiUrl],
  ] as const) {
    if (!isPublicHttpsUrl(value)) {
      return err(
        'PRECONDITION_FAILED',
        `${name} must be a public https origin to send outbound mail`,
        `Refusing to send: the unsubscribe / inquiry link host derived from ${name} ("${value}") is not a public https URL. A non-public or non-https opt-out link is a spam signal and a broken opt-out. Point ${name} at the deployment's public https origin.`,
      )
    }
  }
  return ok(undefined)
}

// Shared by every email send path and the draft preview so the preview can't
// drift from the real send. Allocating the inquiry token is the only write.
async function buildOutreachFooter(
  db: Db,
  tenantId: TenantId,
  ctx: SendContext,
  args: {
    prospectId: number
    outreachLogId: number
    compliance: TenantComplianceProjection
    inquiryLandingEnabled: boolean
    unsubscribeEnabled: boolean
    footerOverride: string | null
    targetLanguage: Locale
  },
): Promise<{ footer: string; headers: Record<string, string>; inquiryUrl: string | null }> {
  const inquiryUrl = await allocateInquiryUrl(
    db,
    tenantId,
    ctx.appUrl,
    args.outreachLogId,
    args.inquiryLandingEnabled,
  )
  const identity = localizeComplianceIdentity(args.compliance, args.targetLanguage)
  const attachments = await buildComplianceAttachments({
    prospectId: args.prospectId,
    tenantId,
    inquiryUrl,
    unsubscribeEnabled: args.unsubscribeEnabled,
    appUrl: ctx.appUrl,
    apiUrl: ctx.apiUrl,
    secret: ctx.unsubscribeSecret,
    tenantLegalName: identity.legalName,
    tenantPhysicalAddress: identity.physicalAddress,
    locale: args.targetLanguage,
    footerOverride: args.footerOverride,
  })
  return { footer: attachments.footer, headers: attachments.headers, inquiryUrl }
}

// Compliance rules ship for US + CA + JP only; other jurisdictions blocked.
// NULL is warn-only so the send proceeds and the warn surfaces in
// observability for backfill.
async function assertProspectCountryAllowed(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<ServiceResult<undefined>> {
  const effective = await loadEffectiveRecipientCountry(db, tenantId, prospectId)
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

async function assertProspectContactable(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<ServiceResult<undefined>> {
  const [row] = await db
    .select({ doNotContact: prospects.doNotContact })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)
  // Missing prospect → defer to the caller's requireProspect NOT_FOUND.
  if (!row) return ok(undefined)
  if (row.doNotContact) {
    return err('UNPROCESSABLE', 'Prospect is on do-not-contact list')
  }
  return ok(undefined)
}

// Send-time backstop (column read, no network): listReachable already excludes
// 'undeliverable', so this only catches a direct send bypassing the gate. Keyed
// on the prospect's stored email, which `to` is expected to match.
async function assertEmailDeliverable(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<ServiceResult<undefined>> {
  const [row] = await db
    .select({ emailDeliverability: prospects.emailDeliverability })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)
  // Missing prospect → defer to the caller's requireProspect NOT_FOUND.
  if (!row) return ok(undefined)
  if (row.emailDeliverability === UNDELIVERABLE) {
    return err('UNPROCESSABLE', 'Recipient email domain cannot receive mail (DNS-confirmed undeliverable)')
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
  const [resolved, prospectGuard, quota, compliance] = await Promise.all([
    resolveProject(db, tenantId, input.projectId),
    requireProspect(db, tenantId, input.prospectId),
    sending ? getRemainingOutreachQuota(db, tenantId, edition) : Promise.resolve(null),
    sending ? assertTenantComplianceReady(db, tenantId) : Promise.resolve(null),
  ])
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  if (!prospectGuard.ok) return prospectGuard
  if (compliance && !compliance.ok) return compliance
  const quotaErr = quota ? outreachQuotaErrorIfExhausted(quota) : null
  if (quotaErr) return quotaErr

  // Resolved once per email send: the cap check, the row's sending_identity_id,
  // and the first-send ramp stamp.
  let sendingIdentityId: SendingIdentityId | null = null
  if (sending) {
    // Backstop: record_outreach('sent') logs an already-completed send.
    if (input.channel === 'email') {
      sendingIdentityId = await resolveSendingIdentityId(db, { tenantId, projectId })
      const mailboxErr = mailboxQuotaErrorIfExhausted(
        await getMailboxDailyQuota(db, tenantId, sendingIdentityId),
      )
      if (mailboxErr) return mailboxErr
    }
    const contactable = await assertProspectContactable(db, tenantId, input.prospectId)
    if (!contactable.ok) return contactable
    const country = await assertProspectCountryAllowed(db, tenantId, input.prospectId)
    if (!country.ok) return country
  }

  const sentAt = new Date()
  const hadFreshSignal = await prospectHadFreshSignal(db, tenantId, input.prospectId)

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      variantId: input.variantId ?? null,
      status: input.status,
      sentAt,
      errorMessage: input.status === 'failed' ? input.errorMessage : null,
      hadFreshSignal,
      sendingIdentityId,
    })
    .returning({ id: outreachLogs.id })

  // Drafts (pending_review) intentionally leave the prospect reachable;
  // listReachable excludes them via a separate NOT EXISTS so the status
  // keeps its real-world meaning.
  if (input.status === 'sent' && log) {
    await markProspectContacted(db, projectId, input.prospectId, sentAt, log.id)
    if (input.channel === 'email') {
      await stampMailboxFirstSendIfNeeded(db, tenantId, sendingIdentityId, sentAt)
    }
  } else if (input.status === 'failed' && log) {
    await deferProspectReeligibility(db, projectId, input.prospectId, sentAt)
  }

  return ok({ id: log?.id as number | undefined })
}

// A deliberate skip: an outbound run decided NOT to contact this prospect for
// an LLM-judged reason the server cannot determine itself — bad timing or no
// fresh re-approach material. No quota is consumed (only 'sent' counts) and
// the prospect is NOT flipped to 'contacted'.
export async function skipProspect(
  db: Db,
  tenantId: TenantId,
  input: SkipProspectInput,
): Promise<ServiceResult<{ id: number | undefined }>> {
  const [resolved, prospectGuard] = await Promise.all([
    resolveProject(db, tenantId, input.projectId),
    requireProspect(db, tenantId, input.prospectId),
  ])
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  if (!prospectGuard.ok) return prospectGuard

  const sentAt = new Date()
  const hadFreshSignal = await prospectHadFreshSignal(db, tenantId, input.prospectId)

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      // errorMessage stays NULL: a deliberate skip is not an error, and the
      // recent-outreach feed renders errorMessage as a red "Error:" line.
      body: buildSkipAuditBody(input.reason, input.note),
      status: 'skipped',
      skipReason: input.reason,
      sentAt,
      hadFreshSignal,
    })
    .returning({ id: outreachLogs.id })

  if (log) {
    await deferProspectReeligibility(db, projectId, input.prospectId, sentAt)
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
  const resolved = await resolveProject(db, tenantId, input.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  const [prospectGuard, sendSettings, complianceResult] = await Promise.all([
    requireProspect(db, tenantId, input.prospectId),
    loadProjectSendSettings(db, projectId),
    assertTenantComplianceReady(db, tenantId),
  ])
  if (!prospectGuard.ok) return prospectGuard
  if (!complianceResult.ok) return complianceResult

  const hostGuard = assertPublicHttpsSendHosts(ctx)
  if (!hostGuard.ok) return hostGuard

  const willSend = sendSettings.outboundMode === 'send'

  if (willSend) {
    const contactable = await assertProspectContactable(db, tenantId, input.prospectId)
    if (!contactable.ok) return contactable
    const quota = await getRemainingOutreachQuota(db, tenantId, edition)
    const quotaErr = outreachQuotaErrorIfExhausted(quota)
    if (quotaErr) return quotaErr
    const country = await assertProspectCountryAllowed(db, tenantId, input.prospectId)
    if (!country.ok) return country
  }

  const sentAt = new Date()
  const status: OutreachStatus = willSend ? 'pre_send' : 'pending_review'
  const hadFreshSignal = await prospectHadFreshSignal(db, tenantId, input.prospectId)

  const [log] = await db
    .insert(outreachLogs)
    .values({
      tenantId,
      projectId,
      prospectId: input.prospectId,
      channel: input.channel,
      subject: input.subject ?? null,
      body: input.body,
      variantId: input.variantId ?? null,
      status,
      sentAt,
      hadFreshSignal,
    })
    .returning({ id: outreachLogs.id })

  if (!log) return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')

  const attachments = await buildOutreachFooter(db, tenantId, ctx, {
    prospectId: input.prospectId,
    outreachLogId: log.id,
    compliance: complianceResult.value,
    inquiryLandingEnabled: sendSettings.inquiryLandingEnabled,
    unsubscribeEnabled: sendSettings.unsubscribeEnabled,
    footerOverride: sendSettings.footerOverride,
    targetLanguage: sendSettings.targetLanguage,
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
    inquiryUrl: attachments.inquiryUrl,
  })
}

// Resolves a 'pre_send' allocation ('failed' refunds the in-flight quota
// reservation). Restricted to the 'pre_send' → terminal transition so callers
// can't repurpose this for arbitrary flips.
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
    // Only form/SNS pre_send rows reach here; email sends complete inline in
    // sendAndRecord / sendDraft (where the warmup clock is stamped).
    await markProspectContacted(db, updated.projectId as ProjectId, updated.prospectId, updated.sentAt, updated.id)
  } else if (input.status === 'failed') {
    await deferProspectReeligibility(db, updated.projectId as ProjectId, updated.prospectId, updated.sentAt)
  }

  return ok({ id: updated.id })
}

// Branches on the project's outboundMode (loaded server-side, never passed by
// the caller) so the mode decision is deterministic and lives here, not in
// skill logic.
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
  const resolved = await resolveProject(db, tenantId, input.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  const [prospectGuard, sendSettings, complianceResult] = await Promise.all([
    requireProspect(db, tenantId, input.prospectId),
    loadProjectSendSettings(db, projectId),
    assertTenantComplianceReady(db, tenantId),
  ])
  if (!prospectGuard.ok) return prospectGuard
  // Compliance must gate both branches: even in draft mode the user clicks
  // "send from /drafts" later, and we want the 412 to surface at allocation
  // (skill, /outbound report) rather than at confirm time after the body's
  // already been composed.
  if (!complianceResult.ok) return complianceResult
  const hadFreshSignal = await prospectHadFreshSignal(db, tenantId, input.prospectId)
  if (sendSettings.outboundMode === 'draft') {
    const sentAt = new Date()
    const [log] = await db
      .insert(outreachLogs)
      .values({
        tenantId,
        projectId,
        prospectId: input.prospectId,
        channel: 'email',
        subject: input.subject,
        body: input.body,
        status: 'pending_review',
        sentAt,
        variantId: input.variantId ?? null,
        hadFreshSignal,
      })
      .returning({ id: outreachLogs.id })

    if (!log) return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')
    return ok({ mode: 'drafted', outreachId: log.id })
  }

  const compliance = complianceResult.value

  const hostGuard = assertPublicHttpsSendHosts(ctx)
  if (!hostGuard.ok) return hostGuard

  const contactable = await assertProspectContactable(db, tenantId, input.prospectId)
  if (!contactable.ok) return contactable

  const deliverable = await assertEmailDeliverable(db, tenantId, input.prospectId)
  if (!deliverable.ok) return deliverable

  const quota = await getRemainingOutreachQuota(db, tenantId, edition)
  const quotaErr = outreachQuotaErrorIfExhausted(quota)
  if (quotaErr) return quotaErr

  const sendingIdentityId = await resolveSendingIdentityId(db, { tenantId, projectId })
  const mailboxQuota = await getMailboxDailyQuota(db, tenantId, sendingIdentityId)
  const mailboxErr = mailboxQuotaErrorIfExhausted(mailboxQuota)
  if (mailboxErr) return mailboxErr

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
      projectId,
      prospectId: input.prospectId,
      channel: 'email',
      subject: input.subject,
      body: input.body,
      status: 'pre_send',
      sentAt,
      variantId: input.variantId ?? null,
      hadFreshSignal,
      // Stamped at allocation so the in-flight reservation counts toward the cap.
      sendingIdentityId,
    })
    .returning({ id: outreachLogs.id })

  if (!log) {
    return err('INTERNAL_ERROR', 'Failed to allocate outreach log row')
  }

  const attachments = await buildOutreachFooter(db, tenantId, ctx, {
    prospectId: input.prospectId,
    outreachLogId: log.id,
    compliance,
    inquiryLandingEnabled: sendSettings.inquiryLandingEnabled,
    unsubscribeEnabled: sendSettings.unsubscribeEnabled,
    footerOverride: sendSettings.footerOverride,
    targetLanguage: sendSettings.targetLanguage,
  })
  const sendBody = `${input.body}${attachments.footer}`

  const result = await sendForIdentity(db, {
    tenantId,
    identityId: sendingIdentityId,
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
    await deferProspectReeligibility(db, projectId, input.prospectId, sentAt)
    return err('BAD_GATEWAY', result.error, result.detail, { outreachId: log.id })
  }

  // sentAt stays at pre_send allocation time — see updateOutreachStatus.
  await db
    .update(outreachLogs)
    .set({ status: 'sent', fromEmail: result.from, messageId: result.rfc822MessageId })
    .where(eq(outreachLogs.id, log.id))
  await markProspectContacted(db, projectId, input.prospectId, sentAt, log.id)
  await stampMailboxFirstSendIfNeeded(db, tenantId, sendingIdentityId, sentAt)

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
  // Excludes bounce / auto_reply, so the dashboard feed doesn't show a bounce as a "Replied" event.
  countableResponseCount: number
  latestResponseAt: string | null
  hasMeetingRequest: boolean
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
  projectRef: ProjectRef,
  query: RecentOutreachQuery,
): Promise<ServiceResult<{ logs: RecentOutreachLog[]; total: number }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return listRecentOutreachById(db, tenantId, resolved.value, query)
}

export async function listRecentOutreachById(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  query: RecentOutreachQuery,
): Promise<ServiceResult<{ logs: RecentOutreachLog[]; total: number }>> {
  const { limit, offset } = query

  const visibleStatusFilter = and(
    eq(outreachLogs.projectId, projectId),
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
        countableResponseCount: sql<number>`COALESCE(COUNT(${responses.id}) FILTER (WHERE ${responses.responseType} NOT IN ('bounce', 'auto_reply'))::int, 0)`,
        latestResponseAt: sql<string | null>`MAX(${responses.receivedAt})`,
        hasMeetingRequest: sql<boolean>`COALESCE(bool_or(${responses.responseType} = 'meeting_request'), false)`,
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

export type DraftPreview = {
  footer:
    // in_body: form/SNS drafts already carry the footer in the body.
    // unavailable: email draft with no footer — compliance incomplete or
    //   recipient country unsupported.
    | { kind: 'rendered'; text: string }
    | { kind: 'in_body' }
    | { kind: 'unavailable' }
}

export async function listDrafts(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  query: ListDraftsQuery,
): Promise<ServiceResult<{ drafts: DraftRow[]; total: number }>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

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
  const hostGuard = assertPublicHttpsSendHosts(ctx)
  if (!hostGuard.ok) return hostGuard
  const quotaErr = outreachQuotaErrorIfExhausted(quota)
  if (quotaErr) return quotaErr

  const sendingIdentityId = await resolveSendingIdentityId(db, {
    tenantId,
    projectId: draft.projectId as ProjectId,
  })
  const mailboxErr = mailboxQuotaErrorIfExhausted(
    await getMailboxDailyQuota(db, tenantId, sendingIdentityId),
  )
  if (mailboxErr) return mailboxErr

  const [sendSettings, complianceResult, countryResult] = await Promise.all([
    loadProjectSendSettings(db, draft.projectId as ProjectId),
    assertTenantComplianceReady(db, tenantId),
    assertProspectCountryAllowed(db, tenantId, draft.prospectId),
  ])
  if (!complianceResult.ok) return complianceResult
  if (!countryResult.ok) return countryResult
  const compliance = complianceResult.value

  const attachments = await buildOutreachFooter(db, tenantId, ctx, {
    prospectId: draft.prospectId,
    outreachLogId: draft.id,
    compliance,
    inquiryLandingEnabled: sendSettings.inquiryLandingEnabled,
    unsubscribeEnabled: sendSettings.unsubscribeEnabled,
    footerOverride: sendSettings.footerOverride,
    targetLanguage: sendSettings.targetLanguage,
  })
  const sendBody = `${draft.body}${attachments.footer}`

  const result = await sendForIdentity(db, {
    tenantId,
    identityId: sendingIdentityId,
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
      ...(result.ok ? { fromEmail: result.from, sendingIdentityId: result.identityId, messageId: result.rfc822MessageId } : {}),
    })
    .where(eq(outreachLogs.id, draft.id))

  if (!result.ok) {
    await deferProspectReeligibility(db, draft.projectId as ProjectId, draft.prospectId, sentAt)
    return err('BAD_GATEWAY', result.error, result.detail, { outreachId: draft.id })
  }

  await markProspectContacted(db, draft.projectId as ProjectId, draft.prospectId, sentAt, draft.id)
  await stampMailboxFirstSendIfNeeded(db, tenantId, sendingIdentityId, sentAt)

  return ok({
    mode: 'sent',
    outreachId: draft.id,
    messageId: result.messageId,
    threadId: result.threadId,
  })
}

// Shares the send-time footer builder, so previewing allocates the inquiry
// token like a real send (the route is POST, not GET).
export async function previewDraft(
  db: Db,
  tenantId: TenantId,
  ctx: SendContext,
  id: number,
): Promise<ServiceResult<DraftPreview>> {
  const draft = await db
    .select({
      projectId: outreachLogs.projectId,
      prospectId: outreachLogs.prospectId,
      channel: outreachLogs.channel,
      status: outreachLogs.status,
    })
    .from(outreachLogs)
    .where(and(eq(outreachLogs.id, id), eq(outreachLogs.tenantId, tenantId)))
    .limit(1)
    .then((rows) => rows[0])

  if (!draft) return err('NOT_FOUND', 'Draft not found')
  if (draft.status !== 'pending_review') {
    return err('CONFLICT', 'Draft already sent or not in review')
  }
  if (draft.channel !== 'email') {
    return ok({ footer: { kind: 'in_body' } })
  }

  const [sendSettings, complianceResult, countryResult] = await Promise.all([
    loadProjectSendSettings(db, draft.projectId as ProjectId),
    assertTenantComplianceReady(db, tenantId),
    assertProspectCountryAllowed(db, tenantId, draft.prospectId),
  ])
  // No footer or token for a send the compliance / country guards would refuse.
  if (!complianceResult.ok || !countryResult.ok) {
    return ok({ footer: { kind: 'unavailable' } })
  }

  const attachments = await buildOutreachFooter(db, tenantId, ctx, {
    prospectId: draft.prospectId,
    outreachLogId: id,
    compliance: complianceResult.value,
    inquiryLandingEnabled: sendSettings.inquiryLandingEnabled,
    unsubscribeEnabled: sendSettings.unsubscribeEnabled,
    footerOverride: sendSettings.footerOverride,
    targetLanguage: sendSettings.targetLanguage,
  })
  return ok({ footer: { kind: 'rendered', text: attachments.footer } })
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

  await markProspectContacted(db, draft.projectId as ProjectId, draft.prospectId, sentAt, draft.id)

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

// Other-tenant or already-sent ids are silently excluded (surfaced via
// skippedIds in explicit-id mode) rather than erroring.
export const discardDraftsBodySchema = z
  .union([
    z.object({
      ids: z.array(outreachLogIdSchema).min(1).max(200),
    }).strict(),
    z.object({
      allInProjectId: projectRefSchema,
    }).strict(),
  ])
export type DiscardDraftsInput = z.infer<typeof discardDraftsBodySchema>

export async function discardDrafts(
  db: Db,
  tenantId: TenantId,
  input: DiscardDraftsInput,
): Promise<ServiceResult<{ deletedIds: number[]; skippedIds: number[] }>> {
  if ('allInProjectId' in input) {
    const resolved = await resolveProject(db, tenantId, input.allInProjectId)
    if (!resolved.ok) return resolved
    const projectId = resolved.value

    const deleted = await db
      .delete(outreachLogs)
      .where(and(
        eq(outreachLogs.projectId, projectId),
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

// Advances both scheduling axes on a successful 'sent'. The months-scale recycle
// (prospects.next_outreach_after, GREATEST) is stamped on EVERY send, not just the
// reachable→contacted flip: otherwise a recycle re-send to an already-'contacted'
// prospect never advances the stamp and listReachable re-picks it every run. A
// send with no active day-scale sequence (first contact or a recycle re-send)
// starts a fresh sequence at touch 1; an in-progress one continues the count.
async function markProspectContacted(
  db: Db,
  projectId: ProjectId,
  prospectId: number,
  at: Date,
  outreachLogId: number,
): Promise<void> {
  // FOR UPDATE serializes concurrent send finalizations for the same prospect on
  // the touch advance below (a read-then-write of followupTouches). Already inside
  // the per-request RLS transaction, so no nested db.transaction() is needed.
  const [pp] = await db
    .select({
      id: projectProspects.id,
      status: projectProspects.status,
      followupTouches: projectProspects.followupTouches,
      nextFollowupAfter: projectProspects.nextFollowupAfter,
    })
    .from(projectProspects)
    .where(and(
      eq(projectProspects.projectId, projectId),
      eq(projectProspects.prospectId, prospectId),
    ))
    .limit(1)
    .for('update')

  if (!pp) return

  const [followUp, settings] = await Promise.all([
    loadProjectFollowUpConfig(db, projectId),
    loadProjectReapproachSettings(db, projectId),
  ])

  const inSequence = pp.nextFollowupAfter !== null
  const thisTouch = (inSequence ? pp.followupTouches : 0) + 1
  // undefined once touches are exhausted (or follow-up disabled) ⇒ no next touch.
  const gap = followUp.enabled ? followUp.gapDays[thisTouch - 1] : undefined
  const nextFollowupAfter: Date | null = gap === undefined ? null : addDays(at, gap)
  const wasReachable = REACHABLE_STATUSES.includes(pp.status)

  await db
    .update(projectProspects)
    .set({
      ...(wasReachable ? { status: 'contacted' as const } : {}),
      followupTouches: thisTouch,
      nextFollowupAfter,
      updatedAt: at,
    })
    .where(eq(projectProspects.id, pp.id))

  await db
    .update(outreachLogs)
    .set({ touchNumber: thisTouch })
    .where(eq(outreachLogs.id, outreachLogId))

  const recycleIso = addDays(at, settings.noResponseRecycleDays).toISOString()
  await db
    .update(prospects)
    .set({
      nextOutreachAfter: sql`GREATEST(${prospects.nextOutreachAfter}, ${recycleIso}::timestamptz)`,
      updatedAt: at,
    })
    .where(eq(prospects.id, prospectId))
}

// Defer a prospect's re-eligibility by noResponseRecycleDays so listReachable
// drops it for that window: without the stamp the next /outbound run re-picks
// the prospect and the LLM burns context re-evaluating the same dead end.
// GREATEST preserves a longer explicit window (e.g. rejection '12_months').
async function deferProspectReeligibility(
  db: Db,
  projectId: ProjectId,
  prospectId: number,
  at: Date,
): Promise<void> {
  const settings = await loadProjectReapproachSettings(db, projectId)
  const recycleAt = addDays(at, settings.noResponseRecycleDays)
  const recycleIso = recycleAt.toISOString()

  // Clear any in-progress day-scale sequence so the follow-up arm doesn't re-
  // present a failed/skipped prospect next run. project_prospects before prospects
  // matches markProspectContacted's lock order (avoids a cross-path deadlock).
  await db
    .update(projectProspects)
    .set({ nextFollowupAfter: null, updatedAt: at })
    .where(and(
      eq(projectProspects.projectId, projectId),
      eq(projectProspects.prospectId, prospectId),
      isNotNull(projectProspects.nextFollowupAfter),
    ))

  await db
    .update(prospects)
    .set({
      nextOutreachAfter: sql`GREATEST(${prospects.nextOutreachAfter}, ${recycleIso}::timestamptz)`,
      updatedAt: at,
    })
    .where(eq(prospects.id, prospectId))
}

