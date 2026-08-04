import { sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { signUnsubscribeToken } from './unsubscribe-token'
import { randomFromAlphabet } from './random-id'
import {
  composeFooterBlock,
  inquiryFooterLine,
  replyUnsubscribeFooterLine,
} from '../domain/inquiry-footer'
import {
  parseSendingIdentitySecret,
  senderAddressFor,
  type GmailOAuthSecret,
  type SendingIdentitySecret,
} from '../domain/sending-identity'
import { sendViaSmtp } from '../services/smtp-send'
import { quotedPrintableEncode } from '../domain/smtp'
import type { Locale } from '../domain/locale'
import {
  asSendingIdentityId,
  type ProjectId,
  type SendingIdentityId,
  type TenantId,
} from '../domain/ids'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'
const GMAIL_MESSAGES_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

export class GoogleAuthError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'GoogleAuthError'
    this.status = status
  }
}

export async function refreshGoogleAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new GoogleAuthError(`Google token refresh failed (${res.status}): ${detail}`, res.status)
  }
  const data = (await res.json()) as { access_token: string }
  return data.access_token
}

export async function sendGmailMessage(args: {
  accessToken: string
  rfc822: string
}): Promise<{ id: string; threadId: string }> {
  const raw = base64UrlEncode(args.rfc822)
  const res = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`Gmail send failed (${res.status}): ${detail}`)
  }
  return (await res.json()) as { id: string; threadId: string }
}

// Gmail discards the Message-ID we put on the wire and stamps its own, which is
// what a reply threads to. Never throws: the send already succeeded, and failing
// it here would invite a double send.
async function readBackRfc822MessageId(accessToken: string, id: string): Promise<string | null> {
  try {
    const res = await fetch(`${GMAIL_MESSAGES_URL}/${id}?format=metadata&metadataHeaders=Message-Id`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) {
      console.warn(`[gmail-send] Message-ID read-back failed (${res.status}); this send cannot be threaded to its replies`)
      return null
    }
    const data = (await res.json()) as { payload?: { headers?: Array<{ name: string; value: string }> } }
    return data.payload?.headers?.find((h) => h.name.toLowerCase() === 'message-id')?.value ?? null
  } catch (e) {
    console.warn(`[gmail-send] Message-ID read-back threw: ${e instanceof Error ? e.message : String(e)}`)
    return null
  }
}

// `override` is sourced from `E2E_RECIPIENT_OVERRIDE` — unset in production
// deploys, so this is a no-op there.
export function applyE2eRedirect<
  T extends {
    to: string[]
    cc?: string[]
    bcc?: string[]
    extraHeaders?: Record<string, string>
  },
>(envelope: T, override: string | null | undefined): T {
  const target = override?.trim()
  if (!target) return envelope
  return {
    ...envelope,
    to: [target],
    cc: undefined,
    bcc: undefined,
    extraHeaders: {
      ...envelope.extraHeaders,
      'X-E2E-Original-To': [
        ...envelope.to,
        ...(envelope.cc ?? []),
        ...(envelope.bcc ?? []),
      ].join(', '),
    },
  }
}

// Built as multipart/alternative so URLs (especially the inquiry-landing and
// unsubscribe footer links) become clickable in HTML-capable clients while
// still rendering for plain-text-only readers.
export function buildRfc822(args: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  // Self-generated RFC822 Message-ID (with angle brackets). Set on every send so
  // replies/bounces thread back to it. Gmail preserves a provided Message-ID; most
  // MSAs preserve it too (a rewriting MSA degrades that identity to sender-recency).
  messageId?: string
  inReplyTo?: string
  extraHeaders?: Record<string, string>
  // SMTP passes 'quoted-printable' (7-bit-clean, no 8BITMIME); Gmail API takes 8bit.
  bodyEncoding?: '8bit' | 'quoted-printable'
}): string {
  const cte = args.bodyEncoding === 'quoted-printable' ? 'quoted-printable' : '8bit'
  const encodeBody =
    args.bodyEncoding === 'quoted-printable' ? quotedPrintableEncode : (b: string) => b
  const lines: string[] = []
  lines.push(`From: ${args.from}`)
  lines.push(`To: ${args.to.join(', ')}`)
  if (args.cc && args.cc.length > 0) lines.push(`Cc: ${args.cc.join(', ')}`)
  if (args.bcc && args.bcc.length > 0) lines.push(`Bcc: ${args.bcc.join(', ')}`)
  lines.push(`Subject: ${encodeMimeHeader(args.subject)}`)
  if (args.messageId) {
    // CR/LF strip is defense-in-depth: the value is server-generated, but a
    // header line must never carry an embedded newline (header injection).
    lines.push(`Message-ID: ${args.messageId.replace(/[\r\n]/g, '')}`)
  }
  if (args.inReplyTo) {
    // Defense-in-depth against header injection: schema is the primary guard,
    // but a CR/LF leak here would let a caller inject arbitrary headers (Bcc).
    const id = args.inReplyTo.replace(/[\r\n]/g, '')
    lines.push(`In-Reply-To: ${id}`)
    lines.push(`References: ${id}`)
  }
  if (args.extraHeaders) {
    for (const [name, value] of Object.entries(args.extraHeaders)) {
      lines.push(`${name}: ${value}`)
    }
  }
  const boundary = `leadace-${crypto.randomUUID()}`
  lines.push('MIME-Version: 1.0')
  lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
  lines.push('')
  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/plain; charset=UTF-8')
  lines.push(`Content-Transfer-Encoding: ${cte}`)
  lines.push('')
  lines.push(encodeBody(args.body))
  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/html; charset=UTF-8')
  lines.push(`Content-Transfer-Encoding: ${cte}`)
  lines.push('')
  lines.push(encodeBody(plainTextToHtmlBody(args.body)))
  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}

export function plainTextToHtmlBody(plain: string): string {
  const escaped = plain
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
  // The match runs against already-escaped text, so URL query-string `&`
  // appears here as `&amp;` — exactly what the resulting href value needs.
  // Trailing sentence punctuation is stripped back out of the link, so an
  // LLM-written body like `... see https://example.com.` doesn't pull the
  // period into the href.
  const linkified = escaped.replace(
    /https?:\/\/[^\s<>"]+/g,
    (match) => {
      const trail = match.match(/[.,;:!?)\]]+$/)?.[0] ?? ''
      const url = trail ? match.slice(0, -trail.length) : match
      return `<a href="${url}">${url}</a>${trail}`
    },
  )
  const withBreaks = linkified.replace(/\r?\n/g, '<br>\n')
  return `<!DOCTYPE html><html><body><div>${withBreaks}</div></body></html>`
}

// The footer line itself satisfies the legal opt-out requirement (CAN-SPAM
// §5(a)(3), CASL §6, 特定電子メール法 — an opt-out mechanism, not a header), so
// the RFC 8058 headers are per-project opt-in. The token is bound to
// (prospectId, tenantId), not the recipient email, so it stays valid even when
// the message is routed to a non-prospect address. Caller resolves
// tenantLegalName / tenantPhysicalAddress via assertTenantComplianceReady first
// (nullable in the DB for auto-provisioning, mandatory at send).
export async function buildComplianceAttachments(args: {
  prospectId: number
  tenantId: TenantId
  inquiryUrl: string | null
  unsubscribeEnabled: boolean
  appUrl: string
  apiUrl: string
  secret: string
  tenantLegalName: string
  tenantPhysicalAddress: string
  locale: Locale
  footerOverride: string | null
}): Promise<{ footer: string; headers: Record<string, string> }> {
  const lines: string[] = []
  const headers: Record<string, string> = {}

  lines.push(args.tenantLegalName)
  lines.push(args.tenantPhysicalAddress)

  const footerSeed = args.prospectId

  if (args.inquiryUrl) {
    lines.push(inquiryFooterLine(args.inquiryUrl, args.locale, footerSeed))
  } else {
    lines.push(replyUnsubscribeFooterLine(args.locale, footerSeed))
  }

  if (args.unsubscribeEnabled) {
    const token = await signUnsubscribeToken(
      { prospectId: args.prospectId, tenantId: args.tenantId },
      args.secret,
    )
    const userUrl = `${args.appUrl}/unsubscribe/${token}`
    const oneClickUrl = `${args.apiUrl}/api/unsubscribe/${token}`
    headers['List-Unsubscribe'] = `<${oneClickUrl}>, <${userUrl}>`
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  }

  const footer = `\n\n${args.footerOverride ?? composeFooterBlock(lines)}`
  return { footer, headers }
}

function base64UrlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function encodeMimeHeader(s: string): string {
  if (/^[\x20-\x7E]*$/.test(s)) return s
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return `=?UTF-8?B?${btoa(binary)}?=`
}

const SENDING_IDENTITY_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function generateSendingIdentityId(): string {
  return randomFromAlphabet(SENDING_IDENTITY_ID_ALPHABET, 21)
}

// RFC822 Message-ID anchor for reply/bounce threading: `<{32 random}@{from-domain}>`.
// The 32-char random local-part is the unforgeable token — a spoofer can't guess
// it, so a reply/DSN echoing it is trusted attribution. Right-hand side mirrors the
// From domain for plausibility; it falls back to a constant when From lacks a domain.
const MESSAGE_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function generateRfc822MessageId(fromEmail: string): string {
  const at = fromEmail.lastIndexOf('@')
  const rawDomain = at >= 0 && at < fromEmail.length - 1 ? fromEmail.slice(at + 1) : 'leadace.ai'
  const domain = rawDomain.replace(/[^A-Za-z0-9.-]/g, '') || 'leadace.ai'
  return `<${randomFromAlphabet(MESSAGE_ID_ALPHABET, 32)}@${domain}>`
}

// On reconnect (ON CONFLICT) the warmup state and identity_id are left untouched
// so the ramp clock survives.
export async function saveGmailRefreshToken(
  db: Db,
  args: {
    tenantId: TenantId
    userId: string
    refreshToken: string
    scope: string
    email: string
    encryptionKey: string
  },
): Promise<void> {
  await db.execute(sql`
    INSERT INTO sending_identities
      (tenant_id, identity_id, user_id, provider, from_email, scope, secret, granted_at, updated_at)
    VALUES (
      ${args.tenantId},
      ${generateSendingIdentityId()},
      ${args.userId},
      'gmail_oauth',
      ${args.email},
      ${args.scope},
      pgp_sym_encrypt(${args.refreshToken}::text, ${args.encryptionKey}),
      now(),
      now()
    )
    ON CONFLICT (tenant_id, user_id) WHERE provider = 'gmail_oauth' DO UPDATE SET
      secret = pgp_sym_encrypt(${args.refreshToken}::text, ${args.encryptionKey}),
      scope = ${args.scope},
      from_email = ${args.email},
      auth_revoked_at = NULL,
      poll_failing_since = NULL,
      last_poll_error = NULL,
      updated_at = now()
  `)
}

export async function loadSendingIdentitySecret(
  db: Db,
  args: {
    tenantId: TenantId
    userId: string
    encryptionKey: string
  },
): Promise<{ identityId: SendingIdentityId; fromEmail: string; secret: GmailOAuthSecret } | null> {
  const rows = await db.execute<{
    identity_id: string
    provider: 'gmail_oauth'
    from_email: string
    secret: string
  }>(sql`
    SELECT
      identity_id,
      provider,
      from_email,
      pgp_sym_decrypt(secret, ${args.encryptionKey})::text AS secret
    FROM sending_identities
    WHERE tenant_id = ${args.tenantId}
      AND user_id = ${args.userId}
      AND provider = 'gmail_oauth'
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    identityId: asSendingIdentityId(row.identity_id),
    fromEmail: row.from_email,
    secret: parseSendingIdentitySecret(row.provider, row.secret),
  }
}

export async function resolveSendingIdentityId(
  db: Db,
  args: { tenantId: TenantId; projectId: ProjectId },
): Promise<SendingIdentityId | null> {
  const rows = await db.execute<{ identity_id: string | null }>(sql`
    SELECT COALESCE(
      (SELECT sending_identity_id FROM project_settings
         WHERE tenant_id = ${args.tenantId} AND project_id = ${args.projectId}),
      (SELECT identity_id FROM sending_identities
         WHERE tenant_id = ${args.tenantId} AND provider = 'gmail_oauth'
           AND auth_revoked_at IS NULL LIMIT 1)
    ) AS identity_id
  `)
  const id = rows[0]?.identity_id
  return id ? asSendingIdentityId(id) : null
}

export async function loadSendingIdentitySecretById(
  db: Db,
  args: {
    tenantId: TenantId
    identityId: SendingIdentityId
    encryptionKey: string
  },
): Promise<{ identityId: SendingIdentityId; fromEmail: string; secret: SendingIdentitySecret } | null> {
  const rows = await db.execute<{
    identity_id: string
    provider: 'gmail_oauth' | 'smtp_imap'
    from_email: string
    secret: string
  }>(sql`
    SELECT
      identity_id,
      provider,
      from_email,
      pgp_sym_decrypt(secret, ${args.encryptionKey})::text AS secret
    FROM sending_identities
    WHERE tenant_id = ${args.tenantId}
      AND identity_id = ${args.identityId}
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  return {
    identityId: asSendingIdentityId(row.identity_id),
    fromEmail: row.from_email,
    secret: parseSendingIdentitySecret(row.provider, row.secret),
  }
}

// Stamp the ramp clock on first send (not connect), so an idle mailbox doesn't
// ramp while dormant. ISO + ::timestamptz: postgres.js (prepare:false) can't
// serialize a Date through raw sql``.
export async function stampMailboxFirstSendIfNeeded(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId | null,
  sentAt: Date,
): Promise<void> {
  if (!identityId) return
  await db.execute(sql`
    UPDATE sending_identities
    SET warmup_started_at = ${sentAt.toISOString()}::timestamptz
    WHERE tenant_id = ${tenantId}
      AND identity_id = ${identityId}
      AND warmup_started_at IS NULL
  `)
}

// Mark rather than delete: the row keeps its warmup state and carries WHY
// sending stopped; the reconnect upsert restores it in place.
export async function markGmailAuthRevoked(
  db: Db,
  args: { tenantId: TenantId; identityId: SendingIdentityId },
): Promise<void> {
  await db.execute(sql`
    UPDATE sending_identities
    SET auth_revoked_at = COALESCE(auth_revoked_at, now())
    WHERE tenant_id = ${args.tenantId}
      AND identity_id = ${args.identityId}
      AND provider = 'gmail_oauth'
  `)
}

// messageId/threadId are the Gmail resource ids (empty for SMTP). rfc822MessageId
// is the threading anchor persisted to outreach_logs.message_id.
export type MailSendResult =
  | { ok: true; kind: 'sent'; messageId: string; threadId: string; rfc822MessageId: string | null; from: string; identityId: SendingIdentityId }
  | { ok: false; httpStatus: 412; error: 'Gmail not connected' | 'Gmail token revoked'; detail: string }
  | { ok: false; httpStatus: 502; error: 'Send failed'; detail: string; from: string }

export function formatFromHeader(email: string, displayName: string | null): string {
  if (!displayName) return email
  // Non-ASCII goes through RFC 2047 encoded-word. encoded-word MUST NOT appear
  // inside a quoted-string (RFC 2047 §5), so we branch here rather than
  // quoting unconditionally — Gmail otherwise renders the raw UTF-8 bytes as
  // Latin-1 mojibake on the recipient side.
  if (/^[\x20-\x7E]*$/.test(displayName)) {
    const escaped = displayName.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return `"${escaped}" <${email}>`
  }
  return `${encodeMimeHeader(displayName)} <${email}>`
}

export async function sendForIdentity(
  db: Db,
  args: {
    tenantId: TenantId
    identityId: SendingIdentityId | null
    encryptionKey: string
    clientId: string
    clientSecret: string
    to: string[]
    cc?: string[]
    bcc?: string[]
    subject: string
    body: string
    inReplyTo?: string
    extraHeaders?: Record<string, string>
    // Optional Send-As alias to use as From:. Must already be verified by the
    // user in Gmail web UI (we have no scope to verify programmatically — that
    // would require gmail.settings.basic which is Restricted/CASA-gated).
    // Gmail rejects unverified aliases at send time; we surface that error.
    senderEmailAlias?: string | null
    senderDisplayName?: string | null
    e2eRecipientOverride?: string | null
  },
): Promise<MailSendResult> {
  if (!args.identityId) {
    return {
      ok: false,
      httpStatus: 412,
      error: 'Gmail not connected',
      detail: 'Connect your Google account in Account settings to enable email sending.',
    }
  }
  const identity = await loadSendingIdentitySecretById(db, {
    tenantId: args.tenantId,
    identityId: args.identityId,
    encryptionKey: args.encryptionKey,
  })
  if (!identity) {
    return {
      ok: false,
      httpStatus: 412,
      error: 'Gmail not connected',
      detail: 'Connect your Google account in Account settings to enable email sending.',
    }
  }

  // From is provider-determined (senderAddressFor): an SMTP mailbox can only send
  // as its own address — a Gmail alias would break SPF/DKIM alignment. RFC822 is
  // built per arm for Bcc: Gmail consumes the Bcc header as its envelope; the smtp
  // arm omits it (bcc rides the explicit RCPT TO) so raw DATA never discloses bcc.
  const sendAsEmail = senderAddressFor(identity.secret.provider, identity.fromEmail, args.senderEmailAlias)
  const fromHeader = formatFromHeader(sendAsEmail, args.senderDisplayName ?? null)
  const envelope = applyE2eRedirect(
    { to: args.to, cc: args.cc, bcc: args.bcc, extraHeaders: args.extraHeaders },
    args.e2eRecipientOverride,
  )
  const rfc822MessageId = generateRfc822MessageId(sendAsEmail)
  const baseRfc822 = {
    from: fromHeader,
    to: envelope.to,
    cc: envelope.cc,
    subject: args.subject,
    body: args.body,
    messageId: rfc822MessageId,
    inReplyTo: args.inReplyTo,
    extraHeaders: envelope.extraHeaders,
  }

  switch (identity.secret.provider) {
    case 'gmail_oauth': {
      let accessToken: string
      try {
        accessToken = await refreshGoogleAccessToken(
          identity.secret.refreshToken,
          args.clientId,
          args.clientSecret,
        )
      } catch (e) {
        if (e instanceof GoogleAuthError && (e.status === 400 || e.status === 401)) {
          // Google rejected the refresh token (revoked / expired / scope dropped).
          await markGmailAuthRevoked(db, { tenantId: args.tenantId, identityId: identity.identityId })
          return {
            ok: false,
            httpStatus: 412,
            error: 'Gmail token revoked',
            detail: 'Reconnect your Google account in Account settings.',
          }
        }
        throw e
      }

      try {
        const rfc822 = buildRfc822({ ...baseRfc822, bcc: envelope.bcc })
        const result = await sendGmailMessage({ accessToken, rfc822 })
        return {
          ok: true,
          kind: 'sent',
          messageId: result.id,
          threadId: result.threadId,
          rfc822MessageId: await readBackRfc822MessageId(accessToken, result.id),
          from: sendAsEmail,
          identityId: identity.identityId,
        }
      } catch (e) {
        return {
          ok: false,
          httpStatus: 502,
          error: 'Send failed',
          detail: e instanceof Error ? e.message : String(e),
          from: sendAsEmail,
        }
      }
    }
    case 'smtp_imap': {
      const recipients = [...envelope.to, ...(envelope.cc ?? []), ...(envelope.bcc ?? [])]
      const result = await sendViaSmtp(
        {
          host: identity.secret.smtpHost,
          port: identity.secret.smtpPort,
          username: identity.secret.username,
          appPassword: identity.secret.appPassword,
        },
        {
          from: sendAsEmail,
          recipients,
          rfc822: buildRfc822({ ...baseRfc822, bodyEncoding: 'quoted-printable' }),
        },
      )
      if (!result.ok) {
        return { ok: false, httpStatus: 502, error: 'Send failed', detail: result.detail, from: sendAsEmail }
      }
      // No Gmail resource ids for SMTP.
      return { ok: true, kind: 'sent', messageId: '', threadId: '', rfc822MessageId, from: sendAsEmail, identityId: identity.identityId }
    }
  }
}
