// Deterministic pre-classification from headers + a top-line reply token; null = hand to the LLM.

import type { RejectionPrimaryReason } from '../db/schema'
import { getHeader, type ParsedEmail } from './email-message'

type Sentiment = 'positive' | 'neutral' | 'negative'

// An opt-out is the unsubscribe responseType, which the ingest gates on trust;
// as a rejection reason it would force do_not_contact on forgeable mail.
export type ReplyRejectionReason = Exclude<RejectionPrimaryReason, 'unsubscribe_request'>

// What a reply means, whether its headers, a reply token or the LLM settled it.
export type ReplyClassification =
  | { sentiment: Sentiment; responseType: 'reply' | 'meeting_request' | 'unsubscribe' | 'auto_reply' | 'bounce' }
  | { sentiment: Sentiment; responseType: 'rejection'; rejection: { reason: ReplyRejectionReason; quote: string | null } }

const settled = (responseType: 'bounce' | 'auto_reply' | 'unsubscribe'): ReplyClassification => ({ sentiment: 'neutral', responseType })
const declined = (reason: ReplyRejectionReason): ReplyClassification => ({
  sentiment: 'neutral',
  responseType: 'rejection',
  rejection: { reason, quote: null },
})

const UNSUBSCRIBE_TOKENS = new Set(['unsubscribe', 'unsubscribeme', '配信停止'])
// Must match the escape-hatch tokens promised in tpl_email_guidelines.
const NOT_ME_TOKENS = new Set(['notme', '担当違い'])
const LATER_TOKENS = new Set(['later', 'またの機会に'])

export function classifyDeterministically(email: ParsedEmail): ReplyClassification | null {
  const from = (getHeader(email.headers, 'from') ?? '').toLowerCase()
  const contentType = (getHeader(email.headers, 'content-type') ?? '').toLowerCase()
  const subject = (getHeader(email.headers, 'subject') ?? '').toLowerCase()

  if (
    contentType.includes('report-type=delivery-status') ||
    contentType.includes('multipart/report') ||
    /\bmailer-daemon\b|\bpostmaster@/.test(from) ||
    getHeader(email.headers, 'x-failed-recipients') !== null
  ) {
    return settled('bounce')
  }

  const autoSubmitted = (getHeader(email.headers, 'auto-submitted') ?? '').toLowerCase()
  if (
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    getHeader(email.headers, 'x-autoreply') !== null ||
    getHeader(email.headers, 'x-autorespond') !== null ||
    getHeader(email.headers, 'x-vacation') !== null ||
    /\b(out of office|auto(matic)?[ -]?reply|on vacation|away from)\b/.test(subject)
  ) {
    return settled('auto_reply')
  }

  const token = firstUnquotedToken(email.bodyText)
  if (token !== null) {
    if (UNSUBSCRIBE_TOKENS.has(token)) return settled('unsubscribe')
    if (NOT_ME_TOKENS.has(token)) return declined('not_decision_maker')
    if (LATER_TOKENS.has(token)) return declined('wrong_timing')
  }

  return null
}

// Our own footer is quoted back in every reply, so match only the first
// non-quoted line — scanning the whole body would opt out everyone who hit Reply.
function firstUnquotedToken(bodyText: string): string | null {
  for (const raw of bodyText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('>')) return null
    return line.toLowerCase().replace(/[\s.,!?;:"'‘’“”「」()（）。、．，！？；：]/g, '')
  }
  return null
}

// Our opt-out footer ("unsubscribe"/"配信停止") is quoted back on every reply, so feeding
// the whole body to the LLM would bias it toward a false unsubscribe → wrongful DNC.
export function leadingUnquotedText(bodyText: string): string {
  const lines: string[] = []
  for (const raw of bodyText.split(/\r?\n/)) {
    if (raw.trim().startsWith('>')) break
    lines.push(raw)
  }
  return lines.join('\n').trim()
}

// Every line the sender wrote, wherever it sits: a bottom-posted or inline
// answer comes after the quote, so a cut at the first quoted line would lose it.
export function unquotedText(bodyText: string): string {
  return bodyText
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('>'))
    .join('\n')
    .trim()
}
