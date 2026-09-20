// Mirrors backend services/suggestions.ts SuggestionRow (Date columns arrive as ISO strings).

export type SuggestionStatus = 'open' | 'dismissed' | 'done';

export interface Suggestion {
  id: number;
  kind: string;
  dedupeKey: string;
  title: string;
  body: string;
  instruction: string;
  status: SuggestionStatus;
  createdAt: string;
  updatedAt: string;
}
