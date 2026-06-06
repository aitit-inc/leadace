import type { InquiryCtaType } from '$lib/types/project-settings';

export type InquirySettings = {
  // Sender identity shown to recipients on the landing as
  // "From {senderDisplayName}, {senderJobTitle} at {senderCompanyName}".
  // senderDisplayName doubles as the Gmail From: display name (also exposed
  // in /project-settings). senderJobTitle is optional and inert without senderDisplayName.
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
  // Landing CTA mode. 'meeting' renders Book/Request meeting (the
  // human-sales path; inquiryCtaUrl is then an optional scheduling URL).
  // 'signup' renders a Sign up button that redirects visitors to
  // inquiryCtaUrl (self-serve, no human follow-up; URL is required).
  inquiryCtaType: InquiryCtaType;
  inquiryCtaUrl: string | null;
};
