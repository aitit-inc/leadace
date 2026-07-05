// Attribution is threading-first (an unforgeable match on a Message-ID we
// generated) with a sender-recency fallback; the returned `binding` tells the
// caller how much to trust it (the bounce→DNC path requires 'threaded').

import { getHeader, parseAddress, parseMessageIdList, type ParsedEmail } from './email-message'
import type { ParsedDsn } from './dsn'

export type InboundReply = {
  messageId: string
  fromEmail: string
  subject: string | null
  bodyText: string
  receivedAt: Date
  // Message-IDs this message threads to; a match against a sent outreach's
  // message_id is unforgeable — a spoofer can't echo our token.
  referencedMessageIds: string[]
  dsn: ParsedDsn | null
}

export type CapturedReply = { email: ParsedEmail; receivedAt: Date; dsn: ParsedDsn | null }

// null when the message lacks a Message-ID (no idempotency key) or a From.
export function toInboundReply(captured: CapturedReply): InboundReply | null {
  const messageId = getHeader(captured.email.headers, 'message-id')
  const fromRaw = getHeader(captured.email.headers, 'from')
  if (!messageId || !fromRaw) return null
  const fromEmail = parseAddress(fromRaw)
  if (!fromEmail) return null
  const referencedMessageIds = [
    ...parseMessageIdList(getHeader(captured.email.headers, 'in-reply-to')),
    ...parseMessageIdList(getHeader(captured.email.headers, 'references')),
    ...(captured.dsn?.originalMessageId ? [captured.dsn.originalMessageId] : []),
  ]
  return {
    messageId,
    fromEmail,
    subject: getHeader(captured.email.headers, 'subject'),
    bodyText: captured.email.bodyText,
    receivedAt: captured.receivedAt,
    referencedMessageIds,
    dsn: captured.dsn,
  }
}

export type OutreachCandidate = {
  outreachLogId: number
  prospectEmail: string
  sentAt: Date
  // The Message-ID we set on this send (null for pre-feature / non-email rows).
  messageId: string | null
}

// 'threaded' = matched a Message-ID we generated (unforgeable). 'sender' = matched
// the From address by recency (forgeable; never gates destructive state).
export type ReplyBinding = 'threaded' | 'sender'
export type Attribution = { outreachLogId: number; binding: ReplyBinding }

export function normalizeEmailForMatch(email: string): string {
  return email.trim().toLowerCase()
}

// Strip the `<>` wrapper and lower-case so a domain re-cased by an MSA still
// matches; the 32-char random local-part carries the uniqueness regardless.
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, '').trim().toLowerCase()
}

// `now` is the trusted poll time (not the sender-controlled Date header), so a
// forged clock can't escape the window. Threading wins over sender-recency;
// ties break to the later send, then later id, for determinism.
export function attributeReply(
  reply: InboundReply,
  candidates: OutreachCandidate[],
  windowDays: number,
  now: Date,
): Attribution | null {
  const nowMs = now.getTime()
  const earliest = nowMs - windowDays * 24 * 60 * 60 * 1000
  const inWindow = (c: OutreachCandidate): boolean => {
    const sent = c.sentAt.getTime()
    return sent <= nowMs && sent >= earliest
  }

  if (reply.referencedMessageIds.length > 0) {
    const referenced = new Set(reply.referencedMessageIds.map(normalizeMessageId))
    let best: OutreachCandidate | null = null
    for (const c of candidates) {
      if (!c.messageId || !referenced.has(normalizeMessageId(c.messageId)) || !inWindow(c)) continue
      if (best === null || isMoreRecent(c, best)) best = c
    }
    if (best !== null) return { outreachLogId: best.outreachLogId, binding: 'threaded' }
  }

  const from = normalizeEmailForMatch(reply.fromEmail)
  let best: OutreachCandidate | null = null
  for (const c of candidates) {
    if (normalizeEmailForMatch(c.prospectEmail) !== from || !inWindow(c)) continue
    if (best === null || isMoreRecent(c, best)) best = c
  }
  return best !== null ? { outreachLogId: best.outreachLogId, binding: 'sender' } : null
}

function isMoreRecent(c: OutreachCandidate, best: OutreachCandidate): boolean {
  const sent = c.sentAt.getTime()
  const bestSent = best.sentAt.getTime()
  return sent > bestSent || (sent === bestSent && c.outreachLogId > best.outreachLogId)
}

// Instrumentation for option A's recall gap: would Final-Recipient attribution
// (option C) have bound this bounce to a real recent send? True = a bounce we
// drop today (not threaded) but C would have recorded. The hourly cron logs the
// count so the A→C trade-off stays data-driven on real bounces.
export function bounceMatchesFinalRecipient(
  finalRecipients: string[],
  candidates: OutreachCandidate[],
  windowDays: number,
  now: Date,
): boolean {
  if (finalRecipients.length === 0) return false
  const recipients = new Set(finalRecipients.map(normalizeEmailForMatch))
  const nowMs = now.getTime()
  const earliest = nowMs - windowDays * 24 * 60 * 60 * 1000
  return candidates.some((c) => {
    const sent = c.sentAt.getTime()
    return recipients.has(normalizeEmailForMatch(c.prospectEmail)) && sent <= nowMs && sent >= earliest
  })
}
