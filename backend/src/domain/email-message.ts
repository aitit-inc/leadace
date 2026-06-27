// Pure, best-effort RFC822 parsing for smtp_imap-fetched raw messages (the gmail
// arm uses the structured Gmail API). Not a full MIME implementation; unhandled
// shapes fall back to raw text, which the downstream classifier tolerates.

export type ParsedEmail = {
  headers: Map<string, string>
  bodyText: string
}

const dec = new TextDecoder()

function unfoldHeaders(headerBlock: string): Map<string, string> {
  const headers = new Map<string, string>()
  const lines = headerBlock.split('\r\n')
  let current = ''
  const flush = () => {
    const colon = current.indexOf(':')
    if (colon > 0) {
      const name = current.slice(0, colon).trim().toLowerCase()
      if (!headers.has(name)) headers.set(name, current.slice(colon + 1).trim())
    }
    current = ''
  }
  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      current += ' ' + line.trim()
    } else {
      flush()
      current = line
    }
  }
  flush()
  return headers
}

export function getHeader(headers: Map<string, string>, name: string): string | null {
  return headers.get(name.toLowerCase()) ?? null
}

// Linear scan, not a backtracking `X+@X+` / `<[^>]+>` regex: the From comes from
// an untrusted mailbox and a crafted value must not be able to ReDoS the poll.
export function parseAddress(value: string): string {
  let bestAngle: string | null = null
  let lastAngle: string | null = null
  for (let i = 0; i < value.length; ) {
    const open = value.indexOf('<', i)
    if (open === -1) break
    const close = value.indexOf('>', open + 1)
    if (close === -1) break
    const inner = value.slice(open + 1, close).trim()
    if (inner) {
      lastAngle = inner
      if (inner.includes('@')) bestAngle = inner
    }
    i = close + 1
  }
  if (bestAngle !== null) return bestAngle
  if (lastAngle !== null) return lastAngle

  const at = value.indexOf('@')
  if (at === -1) return value.trim()
  const isSep = (ch: string | undefined) => ch === undefined || /[\s<>()]/.test(ch)
  let start = at
  while (start > 0 && !isSep(value[start - 1])) start--
  let end = at + 1
  while (end < value.length && !isSep(value[end])) end++
  return value.slice(start, end).trim()
}

export function decodeQuotedPrintable(s: string): string {
  const bytes: number[] = []
  const src = s.replace(/=\r\n/g, '')
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '=' && i + 2 < src.length && /[0-9A-Fa-f]{2}/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(src.charCodeAt(i))
    }
  }
  return dec.decode(Uint8Array.from(bytes))
}

export function decodeBase64(s: string): string {
  try {
    const clean = s.replace(/[^A-Za-z0-9+/=]/g, '')
    return dec.decode(Uint8Array.from(atob(clean), (c) => c.charCodeAt(0)))
  } catch {
    return s
  }
}

function decodeBody(body: string, cte: string | null): string {
  switch ((cte ?? '').trim().toLowerCase()) {
    case 'quoted-printable':
      return decodeQuotedPrintable(body)
    case 'base64':
      return decodeBase64(body)
    default:
      return body
  }
}

function boundaryOf(contentType: string | null): string | null {
  const m = (contentType ?? '').match(/boundary="?([^";]+)"?/i)
  return m ? (m[1] ?? null) : null
}

// Bounded so a crafted deeply-nested multipart message can't overflow the stack.
const MAX_MULTIPART_DEPTH = 8

export function parseEmailMessage(raw: string, depth = 0): ParsedEmail {
  const normalized = raw.replace(/\r\n|\r|\n/g, '\r\n')
  const split = normalized.indexOf('\r\n\r\n')
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split)
  const body = split === -1 ? '' : normalized.slice(split + 4)
  const headers = unfoldHeaders(headerBlock)
  return { headers, bodyText: extractText(headers, body, depth) }
}

// One MIME part, provider-agnostic: the IMAP arm builds these from raw RFC822,
// the Gmail arm from its payload tree, and domain/dsn consumes them uniformly.
export type MessagePart = { mimeType: string; headers: Map<string, string>; body: string }

// Parse only the leading header block of a raw message — used to read the
// returned original's Message-ID out of a DSN's message/rfc822 part body.
export function parseTopHeaders(raw: string): Map<string, string> {
  const normalized = raw.replace(/\r\n|\r|\n/g, '\r\n')
  const split = normalized.indexOf('\r\n\r\n')
  return unfoldHeaders(split === -1 ? normalized : normalized.slice(0, split))
}

// Extract every `<id>` token from an In-Reply-To / References header value.
// The char class forbids spaces/brackets, so it is linear — a crafted header
// can't ReDoS the poll.
export function parseMessageIdList(value: string | null): string[] {
  if (!value) return []
  return value.match(/<[^<>\s]+>/g) ?? []
}

// Flatten a raw RFC822 message into its MIME parts. multipart/* containers
// recurse; message/rfc822 (a DSN's returned original) and message/delivery-status
// stay leaves so domain/dsn can read their text. Mirrors extractText's boundary
// handling but keeps every part instead of collapsing to the text/plain leaf.
export function flattenMessageParts(raw: string, depth = 0): MessagePart[] {
  const normalized = raw.replace(/\r\n|\r|\n/g, '\r\n')
  const split = normalized.indexOf('\r\n\r\n')
  const headerBlock = split === -1 ? normalized : normalized.slice(0, split)
  const body = split === -1 ? '' : normalized.slice(split + 4)
  const headers = unfoldHeaders(headerBlock)
  const contentType = getHeader(headers, 'content-type')
  const mimeType = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const boundary = contentType && /multipart\//i.test(contentType) ? boundaryOf(contentType) : null
  if (!boundary || depth >= MAX_MULTIPART_DEPTH) {
    return [{ mimeType, headers, body: decodeBody(body, getHeader(headers, 'content-transfer-encoding')) }]
  }
  const parts = body
    .split(`--${boundary}`)
    .slice(1)
    .map((p) => p.replace(/^\r\n/, ''))
    .filter((p) => p && !p.startsWith('--'))
  return parts.flatMap((p) => flattenMessageParts(p, depth + 1))
}

function extractText(headers: Map<string, string>, body: string, depth: number): string {
  const contentType = getHeader(headers, 'content-type')
  const boundary = contentType && /multipart\//i.test(contentType) ? boundaryOf(contentType) : null
  if (!boundary || depth >= MAX_MULTIPART_DEPTH) {
    return decodeBody(body, getHeader(headers, 'content-transfer-encoding')).trim()
  }
  const parts = body
    .split(`--${boundary}`)
    .slice(1)
    .map((p) => p.replace(/^\r\n/, ''))
    .filter((p) => p && !p.startsWith('--'))
  const parsed = parts.map((p) => parseEmailMessage(p, depth + 1))
  const plain = parsed.find((p) => {
    const ct = getHeader(p.headers, 'content-type')
    return !ct || /text\/plain/i.test(ct)
  })
  return (plain ?? parsed[0])?.bodyText ?? ''
}
