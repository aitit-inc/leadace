import type { OpenAIRoute } from './openai'

export type JsonOp = 'draft' | 'evaluate' | 'journal' | 'reply-classify' | 'reply-domain-match'
export type PagesJsonOp = 'enrich.site' | 'enrich.pages' | 'enrich.judge' | 'enrich.events' | 'enrich.events.pages' | 'strategy-draft.site' | 'strategy-draft'
export type GroundedTextOp = 'discover.search' | 'strategy-draft.competitors'
export type FollowUpJsonOp = 'discover.extract' | 'strategy-draft.competitors.extract'
export type ToolLoopOp = 'enrich.contact'

// Search skips flex: its bill is mostly per call, which flex does not halve,
// and flex ran past 120 s where standard answered in about 65 s (2026-09-19).
// GPT-6 Luna search took 69–224 s on the eval strategies (2026-09-24).
// Extraction picks from what the search found: on the same search, Luna
// chose the same organizations as Terra across 13 eval passes at a tenth of
// the cost (2026-09-19). Production inputs of up to 136k tokens ran past
// standard's 120 s. It skips flex: its answer runs 5k–11k tokens, which flex
// writes at half standard's speed, so 14 of 20 flex attempts ran past 60 s
// and were redone on standard (2026-09-19).
export const OPENAI_ROUTES: Record<JsonOp | PagesJsonOp | GroundedTextOp | FollowUpJsonOp | ToolLoopOp | 'chat', OpenAIRoute> = {
  'discover.search': { model: 'gpt-6-luna', timeoutMs: 300_000, flexTimeoutMs: null, maxOutputTokens: 24_576 },
  'discover.extract': { model: 'gpt-6-luna', timeoutMs: 180_000, flexTimeoutMs: null, maxOutputTokens: 49_152 },
  draft: { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // Flex answered in 85–104 s with the strategy rewritten (2026-09-19).
  evaluate: { model: 'gpt-6-luna', timeoutMs: 240_000, flexTimeoutMs: 180_000, maxOutputTokens: 32_768 },
  journal: { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 4_096 },
  'reply-classify': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'reply-domain-match': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'enrich.site': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.pages': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.judge': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // The timeout is one turn's; at most nine turns must fit a candidate's step
  // beside its reads (jobs/stages.ts STEP_RETRY). On 50 fits the two reads had found no address
  // for, Luna with search and page opens found 16 and Sol 22, at $0.019 and
  // $0.106 an organization; Sol on the two reads alone found 3 (#887).
  'enrich.contact': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  // Also read inside draft's one-shot send step (10 min), before composing.
  'enrich.events': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  'enrich.events.pages': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  // A person waits on onboarding in the chat.
  'strategy-draft.site': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  // Runs once per project and every later stage builds on what it writes.
  'strategy-draft': { model: 'gpt-6-sol', timeoutMs: 240_000, flexTimeoutMs: null, maxOutputTokens: 32_768 },
  'strategy-draft.competitors': { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  'strategy-draft.competitors.extract': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  chat: { model: 'gpt-6-sol', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 16_384 },
}
