import { z } from 'zod'
import type { Channel, DraftReviewVerdict } from '../db/schema'
import { stripAppendedFooter } from './outbound-content'

export const DISCARD_VERDICTS = ['wrong_message', 'wrong_prospect'] as const satisfies readonly DraftReviewVerdict[]
export type DiscardVerdict = (typeof DISCARD_VERDICTS)[number]

export const discardVerdictSchema = z.enum(DISCARD_VERDICTS)
export const discardNoteSchema = z.string().trim().min(1).max(500)

export type DiscardReview = { verdict: DiscardVerdict; note: string | null }

type Reviewed = {
  channel: Channel
  prospectName: string
  industry: string | null
  agentSubject: string | null
  agentBody: string
}

export type DraftReviewEntry =
  | (Reviewed & { verdict: 'edited'; sentSubject: string | null; sentBody: string })
  | (Reviewed & { verdict: DiscardVerdict; note: string | null })

// Which corrections a stage can act on: the writer on the text, the finder on
// who was wrong to contact, the evaluator on both (it owns the Target).
export type ReviewAudience = 'compose' | 'discover' | 'evaluate'

export const REVIEW_CONCERNS: Record<ReviewAudience, readonly DraftReviewVerdict[]> = {
  compose: ['edited', 'wrong_message'],
  discover: ['wrong_prospect'],
  evaluate: ['edited', 'wrong_message', 'wrong_prospect'],
}

function message(subject: string | null, body: string): string {
  const text = stripAppendedFooter(body).trim()
  return subject ? `Subject: ${subject}\n${text}` : text
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
}

// A note is quoted inside a one-line list item.
function quoted(note: string | null): string {
  return note ? `: "${note.replace(/\s+/g, ' ')}"` : ''
}

function entryLines(e: DraftReviewEntry): string {
  const who = `${e.prospectName}${e.industry ? ` (${e.industry})` : ''}`
  switch (e.verdict) {
    case 'edited':
      return `- Rewrote the ${e.channel} draft to ${who}.\n  Ace wrote:\n${indent(message(e.agentSubject, e.agentBody))}\n  They sent:\n${indent(message(e.sentSubject, e.sentBody))}`
    case 'wrong_message':
      return `- Discarded the ${e.channel} draft to ${who} — the message was not right${quoted(e.note)}.\n  Ace wrote:\n${indent(message(e.agentSubject, e.agentBody))}`
    case 'wrong_prospect':
      return `- Discarded the draft to ${who} — wrong prospect${quoted(e.note)}.`
  }
}

export function draftReviewSection(entries: DraftReviewEntry[]): string | null {
  return entries.length > 0 ? entries.map(entryLines).join('\n') : null
}
