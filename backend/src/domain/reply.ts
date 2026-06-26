// Pure core of reply ingest: model a captured reply and decide which sent
// outreach it answers, so the attribution rule is testable without I/O.

import { getHeader, parseAddress, type ParsedEmail } from './email-message'

// Threading fields (In-Reply-To) are intentionally absent: the rule is
// sender-recency, and an unused field is dead weight until threading lands.
export type InboundReply = {
  messageId: string
  fromEmail: string
  subject: string | null
  bodyText: string
  receivedAt: Date
}

export type CapturedReply = { email: ParsedEmail; receivedAt: Date }

// null when the message lacks a Message-ID (no idempotency key) or a From.
export function toInboundReply(captured: CapturedReply): InboundReply | null {
  const messageId = getHeader(captured.email.headers, 'message-id')
  const fromRaw = getHeader(captured.email.headers, 'from')
  if (!messageId || !fromRaw) return null
  const fromEmail = parseAddress(fromRaw)
  if (!fromEmail) return null
  return {
    messageId,
    fromEmail,
    subject: getHeader(captured.email.headers, 'subject'),
    bodyText: captured.email.bodyText,
    receivedAt: captured.receivedAt,
  }
}

export type OutreachCandidate = {
  outreachLogId: number
  prospectEmail: string
  sentAt: Date
}

export function normalizeEmailForMatch(email: string): string {
  return email.trim().toLowerCase()
}

// Among sends to the matching prospect within [now-windowDays, now], pick the
// most recent (ties -> later id, for determinism). `now` is the trusted poll
// time, not the reply's Date header, so a forged clock can't escape the window.
export function attributeReply(
  reply: InboundReply,
  candidates: OutreachCandidate[],
  windowDays: number,
  now: Date,
): number | null {
  const from = normalizeEmailForMatch(reply.fromEmail)
  const nowMs = now.getTime()
  const earliest = nowMs - windowDays * 24 * 60 * 60 * 1000
  let best: OutreachCandidate | null = null
  for (const c of candidates) {
    if (normalizeEmailForMatch(c.prospectEmail) !== from) continue
    const sent = c.sentAt.getTime()
    if (sent > nowMs || sent < earliest) continue
    if (
      best === null ||
      sent > best.sentAt.getTime() ||
      (sent === best.sentAt.getTime() && c.outreachLogId > best.outreachLogId)
    ) {
      best = c
    }
  }
  return best?.outreachLogId ?? null
}
