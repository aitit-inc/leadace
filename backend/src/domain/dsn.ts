// A bounce echoes our original message back in a message/rfc822 or
// text/rfc822-headers part. The Message-ID it carries is the trusted bounce key
// — a spoofed DSN cannot echo an id we generated — and is what gates DNC.
// Final-Recipient is deliberately unused: it is forgeable, and over a week of
// prod bounces it bound nothing threading missed (2026-09).

import { getHeader, parseTopHeaders, type MessagePart } from './email-message'

const RFC822_TYPES = new Set(['message/rfc822', 'text/rfc822-headers'])

export function parseDsnOriginalMessageId(parts: MessagePart[]): string | null {
  const originalPart = parts.find((p) => RFC822_TYPES.has(p.mimeType))
  return originalPart ? extractOriginalMessageId(originalPart) : null
}

// Gmail attaches the returned original's headers to the message/rfc822 part
// itself; an IMAP-fetched DSN keeps them in the part body. Check both.
function extractOriginalMessageId(part: MessagePart): string | null {
  const fromPartHeader = getHeader(part.headers, 'message-id')
  if (fromPartHeader) return normalizeMessageIdToken(fromPartHeader)
  const fromBody = getHeader(parseTopHeaders(part.body), 'message-id')
  return fromBody ? normalizeMessageIdToken(fromBody) : null
}

function normalizeMessageIdToken(raw: string): string {
  const m = raw.match(/<[^<>\s]+>/)
  return m ? m[0] : raw.trim()
}
