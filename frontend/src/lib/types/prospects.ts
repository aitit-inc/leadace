export type ProspectStatus =
  | 'new'
  | 'contacted'
  | 'responded'
  | 'converted'
  | 'rejected'
  | 'inactive'
  | 'deferred';

// Mirrors backend domain/prospect-group.ts ProspectGroup.
export const PROSPECT_GROUPS = ['ace', 'yours', 'need_outside', 'out'] as const;
export type ProspectGroup = (typeof PROSPECT_GROUPS)[number];

export interface SnsAccounts {
  x?: string;
  linkedin?: string;
  instagram?: string;
  facebook?: string;
}

export interface Prospect {
  ppId: number;
  prospectId: number;
  name: string;
  contactName: string | null;
  overview: string;
  industry: string | null;
  websiteUrl: string;
  email: string | null;
  emailNoSolicitation: boolean;
  contactFormUrl: string | null;
  formType: string | null;
  formNoSolicitation: boolean;
  snsAccounts: SnsAccounts | null;
  platformUrl: string | null;
  doNotContact: boolean;
  notes: string | null;
  matchReason: string;
  priority: number;
  status: ProspectStatus;
  group: ProspectGroup;
  evidence: { url: string; claim: string; statedOn: string | null } | null;
  organizationId: number;
  organizationName: string;
  createdAt: string;
}
