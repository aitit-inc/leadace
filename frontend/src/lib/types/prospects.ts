export type ProspectStatus =
  | 'new'
  | 'contacted'
  | 'responded'
  | 'converted'
  | 'rejected'
  | 'inactive'
  | 'deferred';

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
  contactFormUrl: string | null;
  formType: string | null;
  snsAccounts: SnsAccounts | null;
  doNotContact: boolean;
  notes: string | null;
  matchReason: string;
  priority: number;
  status: ProspectStatus;
  organizationId: number;
  organizationName: string;
  createdAt: string;
}
