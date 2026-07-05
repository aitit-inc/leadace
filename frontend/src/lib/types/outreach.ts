import type { SnsAccounts } from './prospects';

export type Channel = 'email' | 'form' | 'sns_twitter' | 'sns_linkedin';

// Mirror of backend OutreachStatus minus 'pre_send' — the endpoints that
// surface this field (listRecentOutreach, org-detail history) exclude
// in-flight 'pre_send' rows server-side. 'skipped' is a deliberate
// no-contact decision and does appear in those feeds.
export type OutreachStatus = 'sent' | 'failed' | 'pending_review' | 'skipped';

export interface OutreachLog {
  id: number;
  prospectId: number;
  prospectName: string;
  prospectEmail: string | null;
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

// Mirror of backend DraftPreview. 'in_body' = form/SNS footer already in the
// body; 'unavailable' = no footer (compliance incomplete or country unsupported).
export type DraftFooter =
  | { kind: 'rendered'; text: string }
  | { kind: 'in_body' }
  | { kind: 'unavailable' };

export interface DraftPreview {
  footer: DraftFooter;
}
