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
  pausedUntil: string | null;
  dailyCapOverride: number | null;
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
