export type OutboundMode = 'send' | 'draft';

export type InquiryCtaType = 'meeting' | 'signup';

// Keep aligned with backend OUTBOUND_CHANNELS (db/schema.ts).
export const OUTBOUND_CHANNELS = ['email', 'form', 'sns_twitter', 'sns_linkedin'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];

// Keep aligned with backend ALLOWED_SEND_COUNTRIES (domain/country.ts).
export const ALLOWED_SEND_COUNTRIES = ['US', 'CA', 'JP'] as const;
export type AllowedSendCountry = (typeof ALLOWED_SEND_COUNTRIES)[number];

export type ProjectSettings = {
  projectId: string;
  outboundMode: OutboundMode;
  senderEmailAlias: string | null;
  senderDisplayName: string | null;
  unsubscribeEnabled: boolean;
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
  outboundChannels: OutboundChannel[];
  targetCountries: AllowedSendCountry[];
  updatedAt: string | null;
};
