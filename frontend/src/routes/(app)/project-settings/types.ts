import type {
  AllowedSendCountry,
  FollowUpSequence,
  OutboundChannel,
  OutboundMode,
} from '$lib/types/project-settings';

export type ProjectSettingsData = {
  projectId: string;
  outboundMode: OutboundMode;
  senderEmailAlias: string | null;
  senderDisplayName: string | null;
  unsubscribeEnabled: boolean;
  followUpSequence: FollowUpSequence;
  outboundChannels: OutboundChannel[];
  targetCountries: AllowedSendCountry[];
  updatedAt: string | null;
};
