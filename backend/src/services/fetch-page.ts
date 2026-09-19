export type FetchedPage = { requestedUrl: string; url: string; text: string }

const TIMEOUT_MS = 20_000
const MAX_BYTES = 3_000_000
const MAX_TEXT_CHARS = 30_000
const MAX_LINKS = 80
// JS shells measured 7–18 characters; a 166-character page still told the
// model what the organization does (2026-09-19). Japanese packs more per character.
const MIN_TEXT_CHARS = 50

function charsetOf(contentType: string | null, head: string): string {
  const declared = contentType?.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  return (declared ?? 'utf-8').toLowerCase()
}

// A JP page may declare Shift_JIS only in <meta>.
function decode(bytes: Uint8Array, contentType: string | null): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  try {
    return new TextDecoder(charsetOf(contentType, head)).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

// Cloudflare's email obfuscation: the first byte is the XOR key for the rest.
export function decodeCfEmail(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){2,256}$/i.test(hex)) return null
  const bytes = hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []
  const [key, ...rest] = bytes
  if (key === undefined) return null
  return String.fromCharCode(...rest.map((b) => b ^ key))
}

function codePoint(n: number): string | null {
  return n <= 0x10ffff ? String.fromCodePoint(n) : null
}

function entities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (m, d: string) => codePoint(Number(d)) ?? m)
    .replace(/&#x([0-9a-f]+);/gi, (m, h: string) => codePoint(parseInt(h, 16)) ?? m)
    .replace(/&amp;/g, '&')
}

function uriDecoded(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

// Linear on any input: a lazy scan to a closing tag that never comes restarts
// at every opening, which on a malformed 3 MB page outruns the Worker's CPU limit.
function withoutBlocks(html: string): string {
  const lower = html.toLowerCase()
  const open = /<!--|<(script|style|noscript|svg|template)\b/g
  let out = ''
  let at = 0
  for (let m = open.exec(lower); m !== null; m = open.exec(lower)) {
    if (m.index < at) continue
    const close = m[1] === undefined ? '-->' : `</${m[1]}`
    const end = lower.indexOf(close, m.index + m[0].length)
    out += html.slice(at, m.index) + ' '
    if (end === -1) return out
    at = lower.indexOf('>', end) + 1 || lower.length
    open.lastIndex = at
  }
  return out + html.slice(at)
}

// Tag patterns stop at the next "<" as well as ">", so each scan ends where the
// next one starts.
function markers(html: string): string {
  return html
    .replace(/<[^<>]+data-cfemail=["']([0-9a-f]+)["'][^<>]*>/gi, (m, hex: string) => ` ${decodeCfEmail(hex) ?? ''} `)
    .replace(/\[email(?:&#160;|&nbsp;|\s)protected\]/gi, ' ')
    .replace(/href=["']\/cdn-cgi\/l\/email-protection#([0-9a-f]+)["']/gi, (_, hex: string) => `href="mailto:${decodeCfEmail(hex) ?? ''}"`)
    .replace(/<a\b[^<>]*href=["']mailto:([^"'?<>]+)[^<>]*>/gi, (_, addr: string) => ` ${uriDecoded(addr)} `)
    .replace(/<form\b([^<>]*)>/gi, (_, attrs: string) => {
      const action = attrs.match(/action=["']([^"']*)["']/i)?.[1] ?? ''
      const cf7 = /wpcf7/i.test(attrs) ? ' wordpress_cf7' : ''
      return ` [form${cf7} action="${action}"] `
    })
    .replace(/<iframe\b[^<>]*src=["']([^"'<>]+)["'][^<>]*>/gi, (_, src: string) => ` [iframe src="${src}"] `)
    .replace(/<[^<>]+class=["'][^"'<>]*(?:g-recaptcha|h-captcha|cf-turnstile)[^"'<>]*["'][^<>]*>/gi, ' [captcha] ')
}

// A "<" that never reaches its ">" before the next "<" is not a tag. Cut first:
// an attribute pattern retried along such a run is quadratic.
function withoutUnclosedTags(html: string): string {
  return html.replace(/<[^<>]*(?=<|$)/g, ' ')
}

export function pageText(html: string): string {
  const cleaned = withoutBlocks(withoutUnclosedTags(html).replace(/<script\b[^<>]*src=["'][^"'<>]*(?:recaptcha|hcaptcha|turnstile)[^"'<>]*["'][^<>]*>/gi, ' [captcha] '))
  return entities(
    markers(cleaned)
      .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/header|\/footer)\b[^<>]*>/gi, '\n')
      .replace(/<[^<>]*>/g, ' '),
  )
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/ *\n\s*/g, '\n')
    .trim()
}

// Links with their text: same-site pages that may carry a contact, and the
// SNS profiles and hosted forms that are contacts themselves.
export function pageLinks(html: string, base: string): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  const closed = withoutUnclosedTags(html)
  for (const m of closed.matchAll(/<a\b[^<>]*href=["']([^"'<>]+)["'][^<>]*>/gi)) {
    let abs: URL
    try {
      abs = new URL(entities(m[1] ?? ''), base)
      abs.hash = ''
    } catch {
      continue
    }
    if (!/^https?:$/.test(abs.protocol) || abs.pathname.startsWith('/cdn-cgi/') || abs.href === base || seen.has(abs.href)) continue
    seen.add(abs.href)
    const after = closed.slice(m.index + m[0].length, m.index + m[0].length + 400)
    const inner = after.slice(0, after.search(/<\/a\s*>/i) === -1 ? 0 : after.search(/<\/a\s*>/i))
    const label = entities(inner.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 80)
    lines.push(`${label || '(no text)'} ${abs.href}`)
    if (lines.length >= MAX_LINKS) break
  }
  return lines
}

async function readCapped(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out.subarray(0, MAX_BYTES)
}

// null: nothing a model could read — failed, not HTML, or too little text.
export async function fetchPage(url: string): Promise<FetchedPage | null> {
  let res: Response
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadAce/1.0; +https://leadace.ai)', accept: 'text/html,text/plain;q=0.9' },
    })
  } catch {
    return null
  }
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || !/text\/(html|plain)|application\/xhtml/i.test(type)) {
    await res.body?.cancel().catch(() => {})
    return null
  }
  let html: string
  try {
    html = decode(await readCapped(res), type)
  } catch {
    return null
  }
  const text = pageText(html)
  if (text.length < MIN_TEXT_CHARS) return null
  const finalUrl = res.url || url
  const links = pageLinks(html, finalUrl)
  const body = text.slice(0, MAX_TEXT_CHARS) + (links.length > 0 ? `\n\nLinks on this page:\n${links.join('\n')}` : '')
  return { requestedUrl: url, url: finalUrl, text: body }
}
