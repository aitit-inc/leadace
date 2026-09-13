// Mirrors backend services/sending-identity.ts SendingIdentitySummary. Dates
// arrive as ISO strings over the wire.
export type SendingIdentityProvider = 'gmail_oauth' | 'smtp_imap';
// Mirrors backend domain/sending-identity.ts MailboxKind: the connected Gmail, a
// Send-As alias under it, or a custom SMTP mailbox.
export type MailboxKind = 'gmail' | 'gmail_alias' | 'smtp';

// Read-only SMTP connection view (the app password is never returned).
export type SmtpConnectionView = {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
};

// Mirrors backend domain/warmup.ts MailboxDailyStatus: future-only pause and
// refusal hold + today's cap/used/remaining + ramp progress.
export type MailboxDailyStatus = {
  pausedUntil: string | null;
  heldUntil: string | null;
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

// Mirrors backend domain/warmup.ts MailboxSendRefusal.
export type MailboxSendRefusal = {
  since: string;
  lastAt: string;
  detail: string;
  sentThatDay: number;
};

export type SendingIdentity = {
  identityId: string;
  provider: SendingIdentityProvider;
  kind: MailboxKind;
  // The connected Gmail a Send-As alias sends through; null for every other kind.
  parentIdentityId: string | null;
  // The Gmail of the account the user signs in with: reconnected by signing in
  // again, never removed from the registry.
  signInAccount: boolean;
  fromEmail: string;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
  sendRefusal: MailboxSendRefusal | null;
  // Google refused the grant; an alias reports its parent's.
  revokedSince: string | null;
  // Projects listing this mailbox, plus for the sign-in account every project that lists none.
  projects: string[];
  grantedAt: string;
  smtp: SmtpConnectionView | null;
} & MailboxDailyStatus &
  MailboxBounceWindow;

// Body for POST /me/sending-identities (smtp_imap only). Both connections are
// verified at registration: SMTP for sending, IMAP for reply collection.
export type RegisterSmtpIdentityInput = {
  fromEmail: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  appPassword: string;
};

// Body for POST /me/sending-identities/gmail-aliases: a verified "Send mail as"
// address of the connected Gmail `parentIdentityId`.
export type RegisterGmailAliasInput = {
  fromEmail: string;
  parentIdentityId: string;
};

// Body for POST /me/sending-identities/google-mailboxes/authorization-url: the
// browser's CSRF nonce, echoed back by Google; loginHint preselects the account.
export type GoogleMailboxAuthorizationInput = {
  state: string;
  loginHint?: string;
};

// Body for POST /me/sending-identities/google-mailboxes: the authorization code
// Google sent to /auth/google-mailbox/callback.
export type RegisterGoogleMailboxInput = {
  code: string;
};

// Partial warmup patch for PUT /me/sending-identities/:id/warmup.
export type MailboxWarmupPatch = {
  dailyCapOverride?: number | null;
  pausedUntil?: string | null;
  resolveRefusal?: true;
};

// Returned by PUT /me/sending-identities/:id/warmup — the resulting health of
// the just-configured mailbox (mirrors backend getMailboxHealth's active shape).
export type MailboxHealth = {
  kind: 'active';
  email: string;
  warmupStartedAt: string | null;
  dailyCapOverride: number | null;
  sendRefusal: MailboxSendRefusal | null;
} & MailboxDailyStatus &
  MailboxBounceWindow;
