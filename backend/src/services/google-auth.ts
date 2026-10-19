import { and, eq } from 'drizzle-orm'
import {
  applyE2eRedirect,
  buildRfc822,
  getGmailAccessToken,
  loadSendingIdentitySecret,
  sendGmailMessage,
} from '../auth/google'
import { sendingIdentities } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'

export type GoogleCtx = {
  encryptionKey: string
  clientId: string
  clientSecret: string
  // E2E redirect; see `applyE2eRedirect` in auth/google. Null in production.
  e2eRecipientOverride: string | null
}

export type CredentialsStatus =
  | { connected: false }
  | { connected: true; email: string; grantedAt: Date; updatedAt: Date; revokedSince: Date | null }

export async function getCredentialsStatus(
  db: Db,
  tenantId: TenantId,
  userId: string,
): Promise<ServiceResult<CredentialsStatus>> {
  const [row] = await db
    .select({
      email: sendingIdentities.fromEmail,
      grantedAt: sendingIdentities.grantedAt,
      updatedAt: sendingIdentities.updatedAt,
      authRevokedAt: sendingIdentities.authRevokedAt,
    })
    .from(sendingIdentities)
    .where(
      and(
        eq(sendingIdentities.tenantId, tenantId),
        eq(sendingIdentities.userId, userId),
        eq(sendingIdentities.signInAccount, true),
      ),
    )
    .limit(1)
  if (!row) return ok({ connected: false })
  return ok({
    connected: true,
    email: row.email,
    grantedAt: row.grantedAt,
    updatedAt: row.updatedAt,
    revokedSince: row.authRevokedAt,
  })
}

// Operator notifications (services/notifications), never prospect outreach —
// the recipient is the operator's own address, so none of the outreach guards
// apply. `to: null` = the sending mailbox itself (a note to self). For
// prospect emails, use the outreach service.
export async function sendNotificationEmail(
  db: Db,
  tenantId: TenantId,
  userId: string,
  ctx: GoogleCtx,
  input: { to: string | null; subject: string; body: string },
): Promise<ServiceResult<{ to: string; messageId: string; threadId: string }>> {
  const identity = await loadSendingIdentitySecret(db, {
    tenantId,
    userId,
    encryptionKey: ctx.encryptionKey,
  })
  if (!identity) {
    return err(
      'PRECONDITION_FAILED',
      'Gmail not connected',
      'Connect your Google account in Settings to enable email sending.',
    )
  }

  const token = await getGmailAccessToken(db, {
    tenantId,
    credentialIdentityId: identity.identityId,
    refreshToken: identity.secret.refreshToken,
    encryptionKey: ctx.encryptionKey,
    clientId: ctx.clientId,
    clientSecret: ctx.clientSecret,
  })
  if (!token.ok) {
    return token.rejection === 'revoked'
      ? err('PRECONDITION_FAILED', 'Gmail token revoked', 'Reconnect your Google account in Settings.')
      : err(
          'PRECONDITION_FAILED',
          'Gmail blocked by Workspace admin',
          "The Google Workspace admin for this account blocked LeadAce's access. Ask the admin to allow LeadAce, then try again.",
        )
  }

  const to = input.to ?? identity.fromEmail
  const envelope = applyE2eRedirect(
    // Marks the mail as machine-sent (RFC 3834): it lands in a mailbox the reply
    // ingest polls, which must not read it as a person's reply.
    { to: [to], cc: undefined, bcc: undefined, extraHeaders: { 'Auto-Submitted': 'auto-generated' } },
    ctx.e2eRecipientOverride,
  )

  const rfc822 = buildRfc822({
    from: identity.fromEmail,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    subject: input.subject,
    body: input.body,
    inReplyTo: undefined,
    extraHeaders: envelope.extraHeaders,
  })

  const result = await sendGmailMessage({ accessToken: token.accessToken, rfc822 })
  return ok({ to, messageId: result.id, threadId: result.threadId })
}
