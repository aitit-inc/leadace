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
// 'domain' = a model tied a same-domain sender to one of our sends (forgeable).
export type ReplyBinding = 'threaded' | 'sender' | 'domain'
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

// Free-mail providers host unrelated people under one domain, so sharing it says
// nothing about who is answering.
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.jp', 'outlook.com', 'outlook.jp',
  'hotmail.com', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'zoho.com', 'yandex.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp',
])

// The sends a reply from the recipient's colleague is judged against.
export function sameDomainCandidates(
  fromEmail: string,
  candidates: OutreachCandidate[],
  windowDays: number,
  now: Date,
  limit: number,
): OutreachCandidate[] {
  const domain = emailDomain(fromEmail)
  if (domain === null || FREE_MAIL_DOMAINS.has(domain)) return []
  const nowMs = now.getTime()
  const earliest = nowMs - windowDays * 24 * 60 * 60 * 1000
  return candidates
    .filter((c) => {
      const sent = c.sentAt.getTime()
      return emailDomain(c.prospectEmail) === domain && sent <= nowMs && sent >= earliest
    })
    .sort((a, b) => (isMoreRecent(a, b) ? -1 : 1))
    .slice(0, limit)
}

function emailDomain(email: string): string | null {
  const normalized = normalizeEmailForMatch(email)
  const at = normalized.lastIndexOf('@')
  return at > 0 && at < normalized.length - 1 ? normalized.slice(at + 1) : null
}
