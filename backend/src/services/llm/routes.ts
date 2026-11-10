import type { OpenAIRoute } from './openai'

export type JsonOp = 'draft' | 'evaluate' | 'journal' | 'reply-classify' | 'reply-domain-match' | 'answer-draft'
export type PagesJsonOp = 'enrich.site' | 'enrich.pages' | 'enrich.judge' | 'enrich.events' | 'enrich.events.pages'
export type GroundedTextOp = 'strategy-draft.competitors'
export type FollowUpJsonOp = 'strategy-draft.competitors.extract'
export type ToolLoopOp = 'discover.search' | 'enrich.evidence' | 'enrich.contact'

export const OPENAI_ROUTES: Record<JsonOp | PagesJsonOp | GroundedTextOp | FollowUpJsonOp | ToolLoopOp | 'chat', OpenAIRoute> = {
  // The timeout is one turn's; the whole pass must fit one step (jobs/stages.ts
  // STEP_RETRY): measured passes took 8–25 minutes with their judging, the
  // search alone 7 on a local run (#1081). A report of 54 candidates ran past
  // 32k output tokens. It skips flex: the bill is mostly per search call,
  // which flex does not halve.
  'discover.search': { model: 'gpt-6-luna', timeoutMs: 300_000, flexTimeoutMs: null, maxOutputTokens: 49_152 },
  draft: { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // Flex answered in 85–104 s with the strategy rewritten (2026-09-19).
  evaluate: { model: 'gpt-6-luna', timeoutMs: 240_000, flexTimeoutMs: 180_000, maxOutputTokens: 32_768 },
  journal: { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: 60_000, maxOutputTokens: 4_096 },
  'reply-classify': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'reply-domain-match': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 2_048 },
  'answer-draft': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  'enrich.site': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.pages': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  'enrich.judge': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: 60_000, maxOutputTokens: 8_192 },
  // The timeout is one turn's; its nine turns, the contact search's nine and
  // five reads with their flex fallbacks fit a candidate's step (jobs/stages.ts
  // STEP_RETRY).
  // Searching 80 organizations took 1–3 minutes each with their judging, at
  // $0.04 an organization (#1081).
  'enrich.evidence': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  // The timeout is one turn's; at most nine turns must fit a candidate's step
  // beside its reads (jobs/stages.ts STEP_RETRY). On 50 fits the two reads had found no address
  // for, Luna with search and page opens found 16 and Sol 22, at $0.019 and
  // $0.106 an organization; Sol on the two reads alone found 3 (#887).
  'enrich.contact': { model: 'gpt-6-luna', timeoutMs: 90_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  // Also read inside draft's one-shot send step (10 min), before composing.
  'enrich.events': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  'enrich.events.pages': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: 30_000, maxOutputTokens: 8_192 },
  // A person waits on onboarding in the chat.
  'strategy-draft.competitors': { model: 'gpt-6-luna', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 8_192 },
  'strategy-draft.competitors.extract': { model: 'gpt-6-luna', timeoutMs: 60_000, flexTimeoutMs: null, maxOutputTokens: 4_096 },
  chat: { model: 'gpt-6-sol', timeoutMs: 120_000, flexTimeoutMs: null, maxOutputTokens: 16_384 },
}
