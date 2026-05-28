import type { Channel } from './outreach';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export type ResponseType =
  | 'reply'
  | 'auto_reply'
  | 'bounce'
  | 'meeting_request'
  | 'rejection';

export interface OutreachResponse {
  id: number;
  channel: Channel;
  content: string;
  sentiment: Sentiment;
  responseType: ResponseType;
  receivedAt: string;
}

export interface ResponseRecord {
  id: number;
  channel: Channel;
  content: string;
  sentiment: Sentiment;
  responseType: ResponseType;
  receivedAt: string;
  prospectId: number;
  prospectName: string;
  outreachSubject: string | null;
}
