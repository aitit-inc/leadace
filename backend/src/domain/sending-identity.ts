import { z } from 'zod'
import type { SendingIdentityProvider } from '../db/schema'

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly'
// What a Google mailbox connected from Account settings asks for: the account's
// email (to name the mailbox), sending, and read-only reply collection.
export const GOOGLE_MAILBOX_SCOPES = `openid email ${GMAIL_SEND_SCOPE} ${GMAIL_READONLY_SCOPE}`

export function hasGmailSendScope(scope: string): boolean {
  return scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)
}

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

// What a mailbox row is: a connected Gmail, a Send-As alias under one (its own
// From, warmup and cap; the parent's credentials and inbox), or an SMTP mailbox.
export type MailboxKind = 'gmail' | 'gmail_alias' | 'smtp'

export function mailboxKind(provider: SendingIdentityProvider, parentIdentityId: string | null): MailboxKind {
  if (provider === 'smtp_imap') return 'smtp'
  return parentIdentityId === null ? 'gmail' : 'gmail_alias'
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
