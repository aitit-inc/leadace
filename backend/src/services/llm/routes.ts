import type { OpenAIRoute } from './openai'

export type JsonOp = 'draft' | 'evaluate' | 'journal' | 'reply-classify' | 'reply-domain-match'
export type PagesJsonOp = 'enrich.site' | 'enrich.pages' | 'enrich.claims' | 'enrich.events' | 'enrich.events.pages' | 'strategy-draft.site' | 'strategy-draft'
export type GroundedTextOp = 'discover.search' | 'strategy-draft.competitors'
export type FollowUpJsonOp = 'discover.extract' | 'strategy-draft.competitors.extract'

// Search skips flex: its bill is mostly per call, which flex does not halve,
// and flex ran past 120 s where standard answered in about 65 s (2026-09-19).
// Extraction picks from what the search found: on the same search, Luna
// chose the same organizations as Terra across 13 eval passes at a tenth of
// the cost (2026-09-19). Production inputs of up to 136k tokens ran past
// standard's 120 s. It skips flex: its answer runs 5k–11k tokens, which flex
// writes at half standard's speed, so 14 of 20 flex attempts ran past 60 s
// and were redone on standard (2026-09-19).
export const OPENAI_ROUTES: Record<JsonOp | PagesJsonOp | GroundedTextOp | FollowUpJsonOp | 'chat', OpenAIRoute> = {
  'discover.search': { model: 'gpt-5.6-luna', timeoutMs: 180_000, flexTimeoutMs: null, maxOutputTokens: 24_576 },
  'discover.extract': { model: 'gpt-5.6-luna', timeoutMs: 180_000, flexTimeoutMs: null, maxOutputTokens: 49_152 },
  draft: { model: 'gpt-5.6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // Flex answered in 85–104 s with the strategy rewritten (2026-09-19).
  evaluate: { model: 'gpt-5.6-luna', timeoutMs: 240_000, flexTimeoutMs: 180_000, maxOutputTokens: 32_768 },
  journal: { model: 'gpt-5.6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 4_096 },
  'reply-classify': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'reply-domain-match': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'enrich.site': { model: 'gpt-5.6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.pages': { model: 'gpt-5.6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.claims': { model: 'gpt-5.6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // Also read inside draft's one-shot send step (10 min), before composing.
  'enrich.events': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  'enrich.events.pages': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  // A person waits on onboarding in the chat.
  'strategy-draft.site': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  // Runs once per project and every later stage builds on what it writes.
  'strategy-draft': { model: 'gpt-5.6-terra', timeoutMs: 240_000, flexTimeoutMs: null, maxOutputTokens: 32_768 },
  'strategy-draft.competitors': { model: 'gpt-5.6-luna', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  'strategy-draft.competitors.extract': { model: 'gpt-5.6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  chat: { model: 'gpt-5.6-terra', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 16_384 },
}
