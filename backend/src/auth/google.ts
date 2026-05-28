import { sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { signUnsubscribeToken } from './unsubscribe-token'
import { inquiryFooterLine } from '../domain/inquiry-footer'
import type { TenantId } from '../domain/ids'

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

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

// Pure helper used by every Gmail-send path. When `override` is non-empty,
// every recipient is rewritten to that single mailbox and the originals are
// preserved in `X-E2E-Original-To`. Sourced from `E2E_RECIPIENT_OVERRIDE` —
// unset in production, a no-op there. Callers pass `null` / `undefined` /
// `""` to disable.
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
// still rendering for plain-text-only readers. The HTML part is auto-derived
// from the plain body — callers continue passing plain text only.
export function buildRfc822(args: {
  from: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  body: string
  inReplyTo?: string
  extraHeaders?: Record<string, string>
}): string {
  const lines: string[] = []
  lines.push(`From: ${args.from}`)
  lines.push(`To: ${args.to.join(', ')}`)
  if (args.cc && args.cc.length > 0) lines.push(`Cc: ${args.cc.join(', ')}`)
  if (args.bcc && args.bcc.length > 0) lines.push(`Bcc: ${args.bcc.join(', ')}`)
  lines.push(`Subject: ${encodeMimeHeader(args.subject)}`)
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
  lines.push('Content-Transfer-Encoding: 8bit')
  lines.push('')
  lines.push(args.body)
  lines.push(`--${boundary}`)
  lines.push('Content-Type: text/html; charset=UTF-8')
  lines.push('Content-Transfer-Encoding: 8bit')
  lines.push('')
  lines.push(plainTextToHtmlBody(args.body))
  lines.push(`--${boundary}--`)
  return lines.join('\r\n')
}

function plainTextToHtmlBody(plain: string): string {
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

// Build the body footer + RFC 8058 List-Unsubscribe headers attached to every
// outbound message. The footer is mandatory and unsubscribe is always
// emitted: CAN-SPAM §5(a)(3) and CASL §6 both require an opt-out mechanism
// in every commercial message, so the project_settings.unsubscribe_enabled
// flag (kept for legacy reasons) is intentionally ignored here. Footer
// carries the tenant's legal identity + physical address, the inquiry link
// when enabled, the privacy policy URL when configured, and the unsubscribe
// link.
//
// The caller MUST resolve `tenantLegalName` / `tenantPhysicalAddress` via
// `assertTenantComplianceReady` before invoking this — those columns are
// nullable in the DB to allow tenant auto-provisioning, but mandatory at
// send time. The unsubscribe token is bound to (prospectId, tenantId), not
// the recipient email, so it stays valid even when the caller routes the
// message to a non-prospect address. Caller supplies the inquiry URL so we
// don't re-allocate a token during a request that has often loaded the same
// row already.
export async function buildComplianceAttachments(args: {
  prospectId: number
  tenantId: TenantId
  inquiryUrl: string | null
  appUrl: string
  apiUrl: string
  secret: string
  tenantLegalName: string
  tenantPhysicalAddress: string
  tenantPrivacyPolicyUrl: string | null
}): Promise<{ footer: string; headers: Record<string, string> }> {
  const lines: string[] = []
  const headers: Record<string, string> = {}

  lines.push(args.tenantLegalName)
  lines.push(args.tenantPhysicalAddress)

  if (args.inquiryUrl) {
    lines.push(inquiryFooterLine(args.inquiryUrl))
  }

  if (args.tenantPrivacyPolicyUrl) {
    lines.push(`Privacy: ${args.tenantPrivacyPolicyUrl}`)
  }

  const token = await signUnsubscribeToken(
    { prospectId: args.prospectId, tenantId: args.tenantId },
    args.secret,
  )
  const userUrl = `${args.appUrl}/unsubscribe/${token}`
  const oneClickUrl = `${args.apiUrl}/api/unsubscribe/${token}`
  lines.push(`Unsubscribe: ${userUrl}`)
  headers['List-Unsubscribe'] = `<${oneClickUrl}>, <${userUrl}>`
  headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'

  const footer = `\n\n---\n${lines.join('\n')}`
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
    INSERT INTO gmail_credentials (tenant_id, user_id, refresh_token, scope, email, granted_at, updated_at)
    VALUES (
      ${args.tenantId},
      ${args.userId},
      pgp_sym_encrypt(${args.refreshToken}::text, ${args.encryptionKey}),
      ${args.scope},
      ${args.email},
      now(),
      now()
    )
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET
      refresh_token = pgp_sym_encrypt(${args.refreshToken}::text, ${args.encryptionKey}),
      scope = ${args.scope},
      email = ${args.email},
      updated_at = now()
  `)
}

export async function loadGmailRefreshToken(
  db: Db,
  args: {
    tenantId: TenantId
    userId: string
    encryptionKey: string
  },
): Promise<{ refreshToken: string; email: string } | null> {
  const rows = await db.execute<{ refresh_token: string; email: string }>(sql`
    SELECT
      pgp_sym_decrypt(refresh_token, ${args.encryptionKey})::text AS refresh_token,
      email
    FROM gmail_credentials
    WHERE tenant_id = ${args.tenantId}
      AND user_id = ${args.userId}
    LIMIT 1
  `)
  const row = rows[0]
  if (!row) return null
  return { refreshToken: row.refresh_token, email: row.email }
}

export async function deleteGmailRefreshToken(
  db: Db,
  args: { tenantId: TenantId; userId: string },
): Promise<void> {
  await db.execute(sql`
    DELETE FROM gmail_credentials
    WHERE tenant_id = ${args.tenantId}
      AND user_id = ${args.userId}
  `)
}

// Discriminated union so callers can map to HTTP status without re-implementing
// the same error mapping in every route handler.
export type GmailSendForUserResult =
  | { ok: true; messageId: string; threadId: string; from: string }
  | { ok: false; httpStatus: 412; error: 'Gmail not connected' | 'Gmail token revoked'; detail: string }
  | { ok: false; httpStatus: 502; error: 'Send failed'; detail: string; from: string }

function formatFromHeader(email: string, displayName: string | null): string {
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

export async function sendGmailForUser(
  db: Db,
  args: {
    tenantId: TenantId
    userId: string
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
    // E2E test override. When non-empty, every recipient is rewritten to
    // this mailbox and the originals are preserved in `X-E2E-Original-To`.
    // Sourced from the worker `E2E_RECIPIENT_OVERRIDE` env, which is unset
    // in production deploys — a no-op there.
    e2eRecipientOverride?: string | null
  },
): Promise<GmailSendForUserResult> {
  const creds = await loadGmailRefreshToken(db, args)
  if (!creds) {
    return {
      ok: false,
      httpStatus: 412,
      error: 'Gmail not connected',
      detail: 'Connect your Google account in Account settings to enable email sending.',
    }
  }

  let accessToken: string
  try {
    accessToken = await refreshGoogleAccessToken(creds.refreshToken, args.clientId, args.clientSecret)
  } catch (e) {
    if (e instanceof GoogleAuthError && (e.status === 400 || e.status === 401)) {
      // Google rejected the refresh token (revoked / expired / scope dropped).
      // Drop the stored credential so /auth/google-credentials/status flips to
      // `disconnected` and the UI surfaces the reconnect affordance instead of
      // showing a stale "connected" status.
      await deleteGmailRefreshToken(db, args)
      return {
        ok: false,
        httpStatus: 412,
        error: 'Gmail token revoked',
        detail: 'Reconnect your Google account in Account settings.',
      }
    }
    throw e
  }

  const sendAsEmail = args.senderEmailAlias?.trim() || creds.email
  const fromHeader = formatFromHeader(sendAsEmail, args.senderDisplayName ?? null)

  const envelope = applyE2eRedirect(
    { to: args.to, cc: args.cc, bcc: args.bcc, extraHeaders: args.extraHeaders },
    args.e2eRecipientOverride,
  )

  const rfc822 = buildRfc822({
    from: fromHeader,
    to: envelope.to,
    cc: envelope.cc,
    bcc: envelope.bcc,
    subject: args.subject,
    body: args.body,
    inReplyTo: args.inReplyTo,
    extraHeaders: envelope.extraHeaders,
  })

  try {
    const result = await sendGmailMessage({ accessToken, rfc822 })
    return { ok: true, messageId: result.id, threadId: result.threadId, from: sendAsEmail }
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
