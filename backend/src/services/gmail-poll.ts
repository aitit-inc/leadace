import type { CapturedReply } from '../domain/reply'
import type { ParsedEmail, MessagePart } from '../domain/email-message'
import { parseDsn } from '../domain/dsn'

// Server-side Gmail reply poll via the Gmail API (requires gmail.readonly),
// normalized to the same CapturedReply the IMAP arm produces. gmail_oauth only.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

type GmailHeader = { name: string; value: string }
export type GmailPart = {
  mimeType?: string
  headers?: GmailHeader[]
  body?: { data?: string }
  parts?: GmailPart[]
}
type GmailFullMessage = { id: string; internalDate?: string; payload?: GmailPart }

export type GmailPollResult =
  | { ok: true; replies: CapturedReply[] }
  | { ok: false; detail: string }

function decodeBase64Url(data: string): string {
  const b64 = data.replace(/-/g, '+').replace(/_/g, '/')
  // Gmail sends base64url without padding; re-pad for a strict atob.
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4)
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}

function headersMap(headers: GmailHeader[] | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const h of headers ?? []) {
    const key = h.name.toLowerCase()
    if (!map.has(key)) map.set(key, h.value)
  }
  return map
}

// Mirror the IMAP arm's extractText (domain/email-message.ts) so both providers
// yield the same body: text/plain preference, trimmed leaf text, and a depth bound
// against hostile nesting (Gmail pre-parses but we don't trust the depth).
const GMAIL_MAX_MULTIPART_DEPTH = 8
export function extractBody(part: GmailPart | undefined, depth = 0): string {
  if (!part) return ''
  const children = part.parts ?? []
  if (children.length === 0 || depth >= GMAIL_MAX_MULTIPART_DEPTH) {
    return part.body?.data ? decodeBase64Url(part.body.data).trim() : ''
  }
  const plain = children.find((c) => {
    const mime = (c.mimeType ?? '').toLowerCase()
    return mime === '' || mime === 'text/plain'
  })
  return extractBody(plain ?? children[0], depth + 1)
}

// Flatten the Gmail payload tree into provider-agnostic MessageParts for DSN
// inspection. Gmail nests a bounce's returned original under a message/rfc822
// node whose FIRST child carries the original's headers (incl. Message-ID), so
// those are surfaced onto the rfc822 part for parseDsn to read.
export function flattenGmailParts(part: GmailPart | undefined): MessagePart[] {
  if (!part) return []
  const mimeType = (part.mimeType ?? '').toLowerCase()
  const ownHeaders = headersMap(part.headers)
  const body = part.body?.data ? decodeBase64Url(part.body.data) : ''
  let headers = ownHeaders
  if (mimeType === 'message/rfc822' && part.parts && part.parts.length > 0) {
    headers = new Map(ownHeaders)
    for (const [k, v] of headersMap(part.parts[0]?.headers)) {
      if (!headers.has(k)) headers.set(k, v)
    }
  }
  return [{ mimeType, headers, body }, ...(part.parts ?? []).flatMap(flattenGmailParts)]
}

export function gmailAfter(d: Date): string {
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

async function gmailGet(path: string, accessToken: string): Promise<Response> {
  return fetch(`${GMAIL_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } })
}

export async function pollGmailInbox(
  accessToken: string,
  since: Date,
  maxMessages: number,
): Promise<GmailPollResult> {
  try {
    const q = encodeURIComponent(`in:inbox after:${gmailAfter(since)}`)
    const listRes = await gmailGet(`?q=${q}&maxResults=${maxMessages}`, accessToken)
    if (!listRes.ok) {
      return { ok: false, detail: `Gmail list failed (${listRes.status}): ${await listRes.text()}` }
    }
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> }
    const ids = (list.messages ?? []).map((m) => m.id)

    const replies: CapturedReply[] = []
    for (const id of ids) {
      const msgRes = await gmailGet(`/${id}?format=full`, accessToken)
      if (!msgRes.ok) continue
      const msg = (await msgRes.json()) as GmailFullMessage
      const email: ParsedEmail = {
        headers: headersMap(msg.payload?.headers),
        bodyText: extractBody(msg.payload),
      }
      const parsedDate = msg.internalDate ? new Date(Number(msg.internalDate)) : null
      const receivedAt = parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : new Date()
      replies.push({ email, receivedAt, dsn: parseDsn(flattenGmailParts(msg.payload)) })
    }
    return { ok: true, replies }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
