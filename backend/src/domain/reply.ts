import { getHeader, parseAddress, parseMessageIdList, type ParsedEmail } from './email-message'

export type InboundReply = {
  messageId: string
  fromEmail: string
  subject: string | null
  bodyText: string
  receivedAt: Date
  referencedMessageIds: string[]
}

export type CapturedReply = {
  email: ParsedEmail
  receivedAt: Date
  dsnOriginalMessageId: string | null
}

// A Message-ID is the dedup key for ingestion, so a message without one is unusable.
export function toInboundReply(captured: CapturedReply): InboundReply | null {
  const messageId = getHeader(captured.email.headers, 'message-id')
  const fromRaw = getHeader(captured.email.headers, 'from')
  if (!messageId || !fromRaw) return null
  const fromEmail = parseAddress(fromRaw)
  if (!fromEmail) return null
  const referencedMessageIds = [
    ...parseMessageIdList(getHeader(captured.email.headers, 'in-reply-to')),
    ...parseMessageIdList(getHeader(captured.email.headers, 'references')),
    ...(captured.dsnOriginalMessageId ? [captured.dsnOriginalMessageId] : []),
  ]
  return {
    messageId,
    fromEmail,
    subject: getHeader(captured.email.headers, 'subject'),
    bodyText: captured.email.bodyText,
    receivedAt: captured.receivedAt,
    referencedMessageIds,
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

// An MSA may re-case the domain in transit; the 32-char random local-part
// carries the uniqueness regardless.
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, '').trim().toLowerCase()
}

// `now` is the trusted poll time (not the sender-controlled Date header), so a
// forged clock can't escape the window.
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

// Instrumentation: we mail info@ and a colleague answers from their own address,
// so neither threading nor From matches and the reply is dropped. An upper bound
// on that gap — unrelated mail from a domain we mailed matches too. Bounces are
// the caller's to exclude (a DSN names the recipient's own domain).
export function fromDomainMatchesRecentSend(
  fromEmail: string,
  candidates: OutreachCandidate[],
  windowDays: number,
  now: Date,
): boolean {
  const domain = emailDomain(fromEmail)
  if (domain === null) return false
  const nowMs = now.getTime()
  const earliest = nowMs - windowDays * 24 * 60 * 60 * 1000
  return candidates.some((c) => {
    const sent = c.sentAt.getTime()
    return emailDomain(c.prospectEmail) === domain && sent <= nowMs && sent >= earliest
  })
}

function emailDomain(email: string): string | null {
  const normalized = normalizeEmailForMatch(email)
  const at = normalized.lastIndexOf('@')
  return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1) : null
}
