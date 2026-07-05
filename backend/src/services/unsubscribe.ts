import { z } from 'zod'
import { and, eq, desc } from 'drizzle-orm'
import {
  prospects,
  organizations,
  outreachLogs,
  type RejectionFeedbackV1,
} from '../db/schema'
import type { Db } from '../db/connection'
import { asTenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { recordResponse } from './responses'
import { rejectionFeedbackCommonSchema } from '../domain/rejection-feedback'

// Only 'sent' rows could have shipped the HMAC unsubscribe link;
// pre_send/pending_review/failed never reached the recipient.
export const unsubscribeTokenParamSchema = z.object({
  token: z.string().min(1),
})

export const withReasonBodySchema = rejectionFeedbackCommonSchema
export type WithReasonInput = z.infer<typeof withReasonBodySchema>

export type UnsubscribeInfo = {
  email: string
  organizationName: string
  alreadyUnsubscribed: boolean
}

export async function getUnsubscribeInfo(
  db: Db,
  prospectId: number,
): Promise<ServiceResult<UnsubscribeInfo>> {
  const [row] = await db
    .select({
      email: prospects.email,
      doNotContact: prospects.doNotContact,
      organizationName: organizations.name,
    })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(eq(prospects.id, prospectId))
    .limit(1)

  if (!row || row.email === null) {
    return err('NOT_FOUND', 'Unsubscribe link is no longer valid')
  }

  return ok({
    email: row.email,
    organizationName: row.organizationName,
    alreadyUnsubscribed: row.doNotContact,
  })
}

export async function markUnsubscribed(
  db: Db,
  prospectId: number,
): Promise<ServiceResult<{ unsubscribed: true }>> {
  const [updated] = await db
    .update(prospects)
    .set({ doNotContact: true, updatedAt: new Date() })
    .where(eq(prospects.id, prospectId))
    .returning({ id: prospects.id })

  if (!updated) {
    return err('NOT_FOUND', 'Unsubscribe link is no longer valid')
  }

  return ok({ unsubscribed: true })
}

// Deprecated for new mails — human-visible unsubscribe-with-reason now flows
// through the inquiry landing. Kept for legacy HMAC-token links and the
// RFC 8058 List-Unsubscribe one-click target. Do not extend. See §6.5.
export async function recordUnsubscribeWithReason(
  db: Db,
  prospectId: number,
  body: WithReasonInput,
): Promise<ServiceResult<{ unsubscribed: true; responseId: number | undefined }>> {
  const submittedAt = new Date()

  const [[prospect], [latestLog]] = await Promise.all([
    db
      .select({ id: prospects.id, tenantId: prospects.tenantId })
      .from(prospects)
      .where(eq(prospects.id, prospectId))
      .limit(1),
    db
      .select({ id: outreachLogs.id, channel: outreachLogs.channel })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.prospectId, prospectId), eq(outreachLogs.status, 'sent')))
      .orderBy(desc(outreachLogs.sentAt))
      .limit(1),
  ])

  if (!prospect) {
    return err('NOT_FOUND', 'Unsubscribe link is no longer valid')
  }

  const feedback: RejectionFeedbackV1 = {
    version: 1,
    primary_reason: body.primary_reason,
    ...(body.secondary_reasons ? { secondary_reasons: body.secondary_reasons } : {}),
    ...(body.free_text ? { free_text: body.free_text } : {}),
    ...(body.preferred_recontact_window ? { preferred_recontact_window: body.preferred_recontact_window } : {}),
    ...(body.consent ? { consent: body.consent } : {}),
    submitted_at: submittedAt.toISOString(),
  }

  // No outreach log → no responses row (channel/log required). Still ratchet
  // DNC since the form's purpose is to stop contact.
  if (!latestLog) {
    await db
      .update(prospects)
      .set({ doNotContact: true, updatedAt: new Date() })
      .where(eq(prospects.id, prospectId))
    return ok({ unsubscribed: true, responseId: undefined })
  }

  // markDoNotContact:true overrides feedbackForcesDoNotContact — the form's
  // whole purpose is to stop further contact. The transaction is needed
  // because this raw-createDb path has no RLS middleware to wrap the
  // multi-write recordResponse.
  return await db.transaction(async (tx) => {
    // PgTransaction → Db cast: same pattern as rls.ts.
    const result = await recordResponse(tx as unknown as Db, asTenantId(prospect.tenantId), {
      outreachLogId: latestLog.id,
      channel: latestLog.channel,
      content: body.free_text ?? '(unsubscribe via link)',
      sentiment: 'negative',
      responseType: 'rejection',
      receivedAt: submittedAt.toISOString(),
      markDoNotContact: true,
      rejectionFeedback: feedback,
    })
    if (!result.ok) return result
    return ok({ unsubscribed: true, responseId: result.value.id })
  })
}
