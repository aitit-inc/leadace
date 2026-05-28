import type { ResponseType, Sentiment } from '$lib/types/responses';

export const SENTIMENTS: Sentiment[] = ['positive', 'neutral', 'negative'];
export const TYPES: ResponseType[] = [
  'reply',
  'auto_reply',
  'bounce',
  'meeting_request',
  'rejection',
];
