import type {
  AllowedSendCountry,
  OutboundChannel,
  OutboundMode,
} from '$lib/types/project-settings';

export type ProjectSettingsData = {
  projectId: string;
  outboundMode: OutboundMode;
  senderEmailAlias: string | null;
  senderDisplayName: string | null;
  unsubscribeEnabled: boolean;
  outboundChannels: OutboundChannel[];
  targetCountries: AllowedSendCountry[];
  updatedAt: string | null;
};
