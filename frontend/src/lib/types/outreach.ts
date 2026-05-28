import type { SnsAccounts } from './prospects';

export type Channel = 'email' | 'form' | 'sns_twitter' | 'sns_linkedin';

// Mirror of backend OutreachStatus minus 'pre_send' — listRecentOutreach
// (the only endpoint that surfaces this field to the UI) excludes in-flight
// rows server-side. If a future endpoint returns raw outreach_logs rows,
// widen this type to include 'pre_send'.
export type OutreachStatus = 'sent' | 'failed' | 'pending_review';

export interface OutreachLog {
  id: number;
  prospectId: number;
  channel: Channel;
  subject: string | null;
  body: string;
  status: OutreachStatus;
  sentAt: string;
  errorMessage: string | null;
  responseCount: number;
  latestResponseAt: string | null;
}

export interface OutreachDraft {
  id: number;
  prospectId: number;
  prospectName: string;
  prospectEmail: string | null;
  prospectContactFormUrl: string | null;
  prospectSnsAccounts: SnsAccounts | null;
  channel: Channel;
  subject: string | null;
  body: string;
  createdAt: string;
}
