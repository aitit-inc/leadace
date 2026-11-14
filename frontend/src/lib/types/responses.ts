import type { Channel } from './outreach';

export type Sentiment = 'positive' | 'neutral' | 'negative';

export type ResponseType =
  | 'reply'
  | 'auto_reply'
  | 'bounce'
  | 'meeting_request'
  | 'rejection';

// Mirrors backend services/responses ResponseAnswer. 'none': a kind that needs no answer.
export type ResponseAnswer = 'waiting' | 'answered' | 'none';

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
  answer: ResponseAnswer;
  answerEmail: AnswerEmail | null;
}

// Mirrors backend services/responses AnswerEmail.
export interface AnswerEmail {
  from: string | null;
  to: string;
  subject: string;
  body: string | null;
  status: 'draft' | 'sending' | 'sent';
  sentAt: string | null;
}

// Mirrors backend services/responses ConversationMessage.
export type ConversationMessage =
  | { kind: 'sent'; at: string; channel: Channel; from: string | null; subject: string | null; body: string }
  | ({ kind: 'received'; at: string; text: string; quoted: string } & Pick<
      ResponseRecord,
      'id' | 'channel' | 'sentiment' | 'responseType' | 'answer' | 'answerEmail'
    >);
