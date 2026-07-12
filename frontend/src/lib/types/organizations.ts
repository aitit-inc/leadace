import type { Channel, OutreachStatus } from './outreach';
import type { ResponseType, Sentiment } from './responses';
import type { SnsAccounts } from './prospects';

export interface Organization {
  id: number;
  name: string;
  domain: string;
  websiteUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationListItem extends Organization {
  prospectCount: number;
  projectCount: number;
}

export interface OrganizationProspect {
  id: number;
  name: string;
  contactName: string | null;
  department: string | null;
  overview: string;
  industry: string | null;
  websiteUrl: string;
  email: string | null;
  contactFormUrl: string | null;
  snsAccounts: SnsAccounts | null;
  platformUrl: string | null;
  doNotContact: boolean;
  notes: string | null;
  createdAt: string;
  projectCount: number;
  outreachCount: number;
  responseCount: number;
  lastInteractionAt: string | null;
  interactions: OrganizationProspectInteraction[];
}

// Newest first.
export type OrganizationProspectInteraction =
  | {
      type: 'outreach';
      id: number;
      channel: Channel;
      status: OutreachStatus;
      subject: string | null;
      sentAt: string;
    }
  | {
      type: 'response';
      id: number;
      outreachLogId: number;
      channel: Channel;
      sentiment: Sentiment;
      responseType: ResponseType;
      receivedAt: string;
    };
