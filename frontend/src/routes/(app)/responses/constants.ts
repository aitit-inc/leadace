import type { ResponseType, Sentiment } from '$lib/types/responses';

export const ANSWERS = ['waiting', 'answered'] as const;
export type AnswerFilter = (typeof ANSWERS)[number];

export const SENTIMENTS: Sentiment[] = ['positive', 'neutral', 'negative'];
export const TYPES: ResponseType[] = [
  'reply',
  'auto_reply',
  'bounce',
  'meeting_request',
  'rejection',
];
