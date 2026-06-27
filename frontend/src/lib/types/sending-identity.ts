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

export type SendingIdentity = {
  identityId: string;
  provider: SendingIdentityProvider;
  fromEmail: string;
  warmupEnabled: boolean;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
  // Derived per-mailbox daily-cap health (mirrors backend mailboxDailyStatus):
  // future-only pause + today's cap/used/remaining + ramp progress.
  pausedUntil: string | null;
  cap: number;
  used: number;
  remaining: number;
  rampWeek: number;
  rampWeeks: number;
  steadyStatePerDay: number;
  grantedAt: string;
  smtp: SmtpConnectionView | null;
};

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
  warmupEnabled?: boolean;
  dailyCapOverride?: number | null;
  pausedUntil?: string | null;
};

// Returned by PUT /me/sending-identities/:id/warmup — the resulting health of
// the just-configured mailbox (mirrors backend getMailboxHealth's active shape).
export type MailboxHealth = {
  kind: 'active';
  email: string;
  warmupEnabled: boolean;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
  pausedUntil: string | null;
  cap: number;
  used: number;
  remaining: number;
  rampWeek: number;
  rampWeeks: number;
  steadyStatePerDay: number;
};
