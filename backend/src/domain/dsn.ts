// Pure parsing of a Delivery Status Notification (bounce). Two facts are
// extracted from the machine-readable parts, provider-agnostically:
//   - finalRecipients: the addresses that failed (message/delivery-status).
//   - originalMessageId: our own Message-ID echoed back in the returned original
//     (message/rfc822 / text/rfc822-headers). This is the *trusted* bounce key:
//     a spoofed DSN can't carry our unguessable Message-ID, so attribution by it
//     gates DNC while finalRecipients alone never does (it is forgeable).
// Returns null when the message has neither machine-readable part — i.e. it is
// not a parseable DSN and the caller should treat it as a normal message.

import { getHeader, parseTopHeaders, type MessagePart } from './email-message'

export type ParsedDsn = {
  finalRecipients: string[]
  originalMessageId: string | null
}

const DELIVERY_STATUS = 'message/delivery-status'
const RFC822_TYPES = new Set(['message/rfc822', 'text/rfc822-headers'])

export function parseDsn(parts: MessagePart[]): ParsedDsn | null {
  const statusPart = parts.find((p) => p.mimeType === DELIVERY_STATUS)
  const originalPart = parts.find((p) => RFC822_TYPES.has(p.mimeType))
  if (!statusPart && !originalPart) return null

  const finalRecipients = statusPart ? parseFinalRecipients(statusPart.body) : []
  const originalMessageId = originalPart ? extractOriginalMessageId(originalPart) : null
  if (finalRecipients.length === 0 && originalMessageId === null) return null
  return { finalRecipients, originalMessageId }
}

// `Final-Recipient: rfc822; user@host` — one per failed recipient. Tolerant of
// the address-type token, surrounding angle brackets, and case; normalized lower.
export function parseFinalRecipients(deliveryStatus: string): string[] {
  const out: string[] = []
  for (const line of deliveryStatus.split(/\r\n|\n/)) {
    const m = line.match(/^final-recipient\s*:\s*[^;]+;\s*(.+)$/i)
    if (!m) continue
    const addr = (m[1] ?? '').trim().replace(/^<|>$/g, '').trim().toLowerCase()
    if (addr) out.push(addr)
  }
  return out
}

// Gmail attaches the returned original's headers to the message/rfc822 part
// itself; an IMAP-fetched DSN keeps them in the part body. Check both.
function extractOriginalMessageId(part: MessagePart): string | null {
  const fromPartHeader = getHeader(part.headers, 'message-id')
  if (fromPartHeader) return normalizeMessageIdToken(fromPartHeader)
  const fromBody = getHeader(parseTopHeaders(part.body), 'message-id')
  return fromBody ? normalizeMessageIdToken(fromBody) : null
}

// Reduce a raw `Message-ID:` value to its `<id>` token (drops CFWS / stray text).
function normalizeMessageIdToken(raw: string): string {
  const m = raw.match(/<[^<>\s]+>/)
  return m ? m[0] : raw.trim()
}
