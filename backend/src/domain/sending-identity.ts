import { z } from 'zod'
import type { SendingIdentityProvider } from '../db/schema'

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'

export function hasReplyReadScope(scope: string | null): boolean {
  return (scope ?? '').split(/\s+/).includes(GMAIL_READONLY_SCOPE)
}

// smtp_imap connection params, stored as an encrypted JSON payload in `secret`.
export const smtpImapSecretPayloadSchema = z.object({
  smtpHost: z.string().min(1),
  // 465 only — implicit TLS is the sole supported submission mode (STARTTLS/587
  // is rejected up front rather than failing later at connect/verify).
  smtpPort: z.literal(465),
  imapHost: z.string().min(1),
  imapPort: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  appPassword: z.string().min(1),
})
export type SmtpImapSecretPayload = z.infer<typeof smtpImapSecretPayloadSchema>

export type SendingIdentitySecret =
  | { provider: 'gmail_oauth'; refreshToken: string }
  | ({ provider: 'smtp_imap' } & SmtpImapSecretPayload)

export type GmailOAuthSecret = Extract<SendingIdentitySecret, { provider: 'gmail_oauth' }>

// From by provider: an SMTP mailbox can only send as its own address, so a Gmail
// Send-As alias is ignored there (using it would break SPF/DKIM alignment).
export function senderAddressFor(
  provider: SendingIdentityProvider,
  fromEmail: string,
  alias: string | null | undefined,
): string {
  if (provider === 'gmail_oauth') return alias?.trim() || fromEmail
  return fromEmail
}

// Overload so a caller that statically knows the provider keeps the narrowed arm.
export function parseSendingIdentitySecret(provider: 'gmail_oauth', decryptedSecret: string): GmailOAuthSecret
export function parseSendingIdentitySecret(provider: SendingIdentityProvider, decryptedSecret: string): SendingIdentitySecret
export function parseSendingIdentitySecret(
  provider: SendingIdentityProvider,
  decryptedSecret: string,
): SendingIdentitySecret {
  switch (provider) {
    case 'gmail_oauth':
      return { provider, refreshToken: decryptedSecret }
    case 'smtp_imap': {
      let payload: unknown
      try {
        payload = JSON.parse(decryptedSecret)
      } catch {
        // Never surface decryptedSecret: V8's JSON.parse message embeds an input
        // snippet, which here would leak the app password into logs / Sentry.
        throw new Error('malformed smtp_imap secret payload')
      }
      return { provider, ...smtpImapSecretPayloadSchema.parse(payload) }
    }
  }
}
