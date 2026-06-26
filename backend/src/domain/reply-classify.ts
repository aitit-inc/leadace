// Deterministic pre-classification: bounces (DSNs) and auto-replies are
// identifiable from headers/sender, so only a genuine human reply needs the LLM.
// null = hand to the LLM classifier.

import { getHeader, type ParsedEmail } from './email-message'

export type DeterministicType = 'bounce' | 'auto_reply'

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

  return null
}
