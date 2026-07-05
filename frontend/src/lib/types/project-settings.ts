export type OutboundMode = 'send' | 'draft';

export type InquiryCtaType = 'meeting' | 'signup';

// Keep aligned with backend OUTBOUND_CHANNELS (db/schema.ts).
export const OUTBOUND_CHANNELS = ['email', 'form', 'sns_twitter', 'sns_linkedin'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

// Keep aligned with backend ALLOWED_SEND_COUNTRIES (domain/country.ts).
export const ALLOWED_SEND_COUNTRIES = ['US', 'CA', 'JP'] as const;
export type AllowedSendCountry = (typeof ALLOWED_SEND_COUNTRIES)[number];

// Keep aligned with backend Locale (domain/locale.ts).
export const TARGET_LANGUAGES = ['en', 'ja'] as const;
export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];

// Keep aligned with backend FollowUpSequence (domain/follow-up-sequence.ts).
export type FollowUpSequence = {
  enabled: boolean;
  gapDays: number[];
};

export type ProjectSettings = {
  projectId: string;
  outboundMode: OutboundMode;
  sendingIdentityId: string | null;
  senderEmailAlias: string | null;
  senderDisplayName: string | null;
  unsubscribeEnabled: boolean;
  footerOverride: string | null;
  // Server-resolved default preview; null until workspace legalName / physicalAddress are set.
  footerDefault: string | null;
  senderCompanyName: string | null;
  senderJobTitle: string | null;
  inquiryLandingEnabled: boolean;
  inquiryChatBrief: string | null;
  inquiryOneLiner: string | null;
  inquiryVideoUrl: string | null;
  inquiryPdfUrl: string | null;
  inquiryBrandColor: string | null;
  inquiryBrandLogoUrl: string | null;
  inquiryDarkBackground: boolean;
  inquiryCtaType: InquiryCtaType;
  inquiryCtaUrl: string | null;
  followUpSequence: FollowUpSequence;
  outboundChannels: OutboundChannel[];
  targetCountries: AllowedSendCountry[];
  targetLanguage: TargetLanguage;
  updatedAt: string | null;
};
