import type { CapturedReply } from '../domain/reply'
import type { ParsedEmail } from '../domain/email-message'

// Server-side Gmail reply poll via the Gmail API (requires gmail.readonly),
// normalized to the same CapturedReply the IMAP arm produces. gmail_oauth only.
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me/messages'

type GmailHeader = { name: string; value: string }
type GmailPart = {
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

function extractBody(part: GmailPart | undefined): string {
  if (!part) return ''
  if ((part.mimeType ?? '').toLowerCase() === 'text/plain' && part.body?.data) {
    return decodeBase64Url(part.body.data)
  }
  for (const sub of part.parts ?? []) {
    const found = extractBody(sub)
    if (found) return found
  }
  if (part.body?.data && !part.parts) return decodeBase64Url(part.body.data)
  return ''
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
      replies.push({ email, receivedAt })
    }
    return { ok: true, replies }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
