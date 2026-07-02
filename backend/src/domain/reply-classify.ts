// Deterministic pre-classification from headers + a top-line opt-out token; null = hand to the LLM.

import { getHeader, type ParsedEmail } from './email-message'

export type DeterministicType = 'bounce' | 'auto_reply' | 'unsubscribe'

const UNSUBSCRIBE_TOKENS = new Set(['unsubscribe', 'unsubscribeme', '配信停止'])

export function detectDeterministicType(email: ParsedEmail): DeterministicType | null {
  const from = (getHeader(email.headers, 'from') ?? '').toLowerCase()
  const contentType = (getHeader(email.headers, 'content-type') ?? '').toLowerCase()
  const subject = (getHeader(email.headers, 'subject') ?? '').toLowerCase()

  if (
    contentType.includes('report-type=delivery-status') ||
    contentType.includes('multipart/report') ||
    /\bmailer-daemon\b|\bpostmaster@/.test(from) ||
    getHeader(email.headers, 'x-failed-recipients') !== null
  ) {
    return 'bounce'
  }

  const autoSubmitted = (getHeader(email.headers, 'auto-submitted') ?? '').toLowerCase()
  if (
    (autoSubmitted !== '' && autoSubmitted !== 'no') ||
    getHeader(email.headers, 'x-autoreply') !== null ||
    getHeader(email.headers, 'x-autorespond') !== null ||
    getHeader(email.headers, 'x-vacation') !== null ||
    /\b(out of office|auto(matic)?[ -]?reply|on vacation|away from)\b/.test(subject)
  ) {
    return 'auto_reply'
  }

  if (isInstructedUnsubscribe(email.bodyText)) return 'unsubscribe'

  return null
}

// Our own footer is quoted back in every reply, so match only the first
// non-quoted line — scanning the whole body would opt out everyone who hit Reply.
function isInstructedUnsubscribe(bodyText: string): boolean {
  for (const raw of bodyText.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('>')) return false
    return UNSUBSCRIBE_TOKENS.has(line.toLowerCase().replace(/[\s.,!?;:"'’“”「」()（）]/g, ''))
  }
  return false
}

// The recipient's own text ends at the first quoted line. Our opt-out footer
// (carries "unsubscribe"/"配信停止") is quoted back on every reply, so feeding the
// whole body to the LLM would bias it toward a false unsubscribe → wrongful DNC.
export function leadingUnquotedText(bodyText: string): string {
  const lines: string[] = []
  for (const raw of bodyText.split(/\r?\n/)) {
    if (raw.trim().startsWith('>')) break
    lines.push(raw)
  }
  return lines.join('\n').trim()
}
