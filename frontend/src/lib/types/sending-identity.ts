// Mirrors backend services/sending-identity.ts SendingIdentitySummary. Dates
// arrive as ISO strings over the wire.
export type SendingIdentityProvider = 'gmail_oauth' | 'smtp_imap';

// Read-only SMTP connection view (the app password is never returned).
export type SmtpConnectionView = {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
};

// Mirrors backend domain/warmup.ts MailboxDailyStatus: future-only pause +
// today's cap/used/remaining + ramp progress.
export type MailboxDailyStatus = {
  pausedUntil: string | null;
  cap: number;
  used: number;
  remaining: number;
  rampWeek: number;
  rampWeeks: number;
  steadyStatePerDay: number;
};

// Mirrors backend domain/warmup.ts MailboxBounceWindow: bounces among the
// threadable sends of a trailing window — a lower bound, since only bounces
// that thread back to a sent message are attributed.
export type MailboxBounceWindow = {
  bounceWindowDays: number;
  sentInWindow: number;
  bounced: number;
  bounceRate: number;
};

export type SendingIdentity = {
  identityId: string;
  provider: SendingIdentityProvider;
  fromEmail: string;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
  grantedAt: string;
  smtp: SmtpConnectionView | null;
} & MailboxDailyStatus &
  MailboxBounceWindow;

// Body for POST /me/sending-identities (smtp_imap only). imapHost/imapPort are
// stored for future reply collection (P3); P1 sending uses SMTP only.
export type RegisterSmtpIdentityInput = {
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  appPassword: string;
};

// Partial warmup patch for PUT /me/sending-identities/:id/warmup.
export type MailboxWarmupPatch = {
  dailyCapOverride?: number | null;
  pausedUntil?: string | null;
};

// Returned by PUT /me/sending-identities/:id/warmup — the resulting health of
// the just-configured mailbox (mirrors backend getMailboxHealth's active shape).
export type MailboxHealth = {
  kind: 'active';
  email: string;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
} & MailboxDailyStatus &
  MailboxBounceWindow;
