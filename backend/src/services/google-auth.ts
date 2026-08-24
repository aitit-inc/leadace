import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import {
  GoogleAuthError,
  applyE2eRedirect,
  buildRfc822,
  loadSendingIdentitySecret,
  refreshGoogleAccessToken,
  saveGmailRefreshToken,
  sendGmailMessage,
} from '../auth/google'
import { GMAIL_SEND_SCOPE } from '../domain/sending-identity'
import { sendingIdentities } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'

export const saveCredentialsSchema = z.object({
  refreshToken: z.string().min(1),
  scope: z.string().min(1),
  email: z.email(),
})
export type SaveCredentialsInput = z.infer<typeof saveCredentialsSchema>

export type GoogleCtx = {
  encryptionKey: string
  clientId: string
  clientSecret: string
  // E2E redirect; see `applyE2eRedirect` in auth/google. Null in production.
  e2eRecipientOverride: string | null
}

export async function saveCredentials(
  db: Db,
  tenantId: TenantId,
  userId: string,
  ctx: { encryptionKey: string },
  input: SaveCredentialsInput,
): Promise<ServiceResult<{ ok: true }>> {
  const grantedScopes = input.scope.split(/\s+/)
  if (!grantedScopes.includes(GMAIL_SEND_SCOPE)) {
    return err(
      'INVALID_INPUT',
      'Missing required scope',
      `gmail.send scope must be granted. Received: ${input.scope}`,
    )
  }

  await saveGmailRefreshToken(db, {
    tenantId,
    userId,
    refreshToken: input.refreshToken,
    scope: input.scope,
    email: input.email,
    encryptionKey: ctx.encryptionKey,
  })

  return ok({ ok: true })
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
        eq(sendingIdentities.provider, 'gmail_oauth'),
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

  let accessToken: string
  try {
    accessToken = await refreshGoogleAccessToken(
      identity.secret.refreshToken,
      ctx.clientId,
      ctx.clientSecret,
    )
  } catch (e) {
    if (e instanceof GoogleAuthError && (e.status === 400 || e.status === 401)) {
      return err(
        'PRECONDITION_FAILED',
        'Gmail token revoked',
        'Reconnect your Google account in Settings.',
      )
    }
    throw e
  }

  const to = input.to ?? identity.fromEmail
  const envelope = applyE2eRedirect(
    { to: [to], cc: undefined, bcc: undefined, extraHeaders: undefined },
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

  const result = await sendGmailMessage({ accessToken, rfc822 })
  return ok({ to, messageId: result.id, threadId: result.threadId })
}
