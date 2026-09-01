import type {
  AllowedSendCountry,
  FollowUpSequence,
  OutboundChannel,
  OutboundMode,
  TargetLanguage,
} from '$lib/types/project-settings';

export type ProjectSettingsData = {
  projectId: string;
  outboundMode: OutboundMode;
  sendingIdentityId: string | null;
  senderEmailAlias: string | null;
  senderDisplayName: string | null;
  unsubscribeEnabled: boolean;
  footerOverride: string | null;
  footerDefault: string | null;
  inquiryLandingEnabled: boolean;
  publicScoreboardEnabled: boolean;
  publicScoreboardEligible: boolean;
  followUpSequence: FollowUpSequence;
  outboundChannels: OutboundChannel[];
  targetCountries: AllowedSendCountry[];
  targetLanguage: TargetLanguage;
  updatedAt: string | null;
};
