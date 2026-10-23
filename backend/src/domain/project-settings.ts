// Fields that bound what the agent may do. An agent sets them only in the web
// chat, behind the person's approval card: an MCP client and an unattended run
// have no one to ask.
export const GUARDED_SETTINGS = [
  'outboundMode',
  'senderDisplayName',
  'senderCompanyName',
  'senderJobTitle',
  'footerOverride',
  'inquiryVideoUrl',
  'inquiryPdfUrl',
  'inquiryBrandColor',
  'inquiryBrandLogoUrl',
  'inquiryDarkBackground',
  'inquiryCtaType',
  'inquiryCtaUrl',
  'publicScoreboardEnabled',
] as const

export type GuardedSetting = (typeof GUARDED_SETTINGS)[number]
