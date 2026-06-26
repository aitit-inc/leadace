// Pure IMAP4rev1 framing for the poll-only client. The one non-obvious rule: a
// "{n}" at a line end introduces n opaque octets that may contain CRLF or
// "tag OK"-looking text, so the framer must skip them by length, not by line.

export function imapResponseEnd(buf: string, tag: string): number | null {
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl === -1) return null
    const line = buf.slice(i, nl)
    const lit = line.match(/\{(\d+)\}$/)
    if (lit) {
      const dataEnd = nl + 2 + Number(lit[1])
      if (dataEnd > buf.length) return null
      i = dataEnd
      continue
    }
    if (line.startsWith(tag + ' ')) return nl + 2
    i = nl + 2
  }
  return null
}

export type ImapStatus = 'OK' | 'NO' | 'BAD'

export function imapTaggedStatus(buf: string, tag: string): ImapStatus | null {
  let i = 0
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i)
    if (nl === -1) break
    const line = buf.slice(i, nl)
    const lit = line.match(/\{(\d+)\}$/)
    if (lit) {
      i = nl + 2 + Number(lit[1])
      continue
    }
    if (line.startsWith(tag + ' ')) {
      const word = line.slice(tag.length + 1).split(' ')[0]?.toUpperCase()
      if (word === 'OK' || word === 'NO' || word === 'BAD') return word
    }
    i = nl + 2
  }
  return null
}

export function parseUidSearch(buf: string): number[] {
  const uids: number[] = []
  for (const line of buf.split('\r\n')) {
    const m = line.match(/^\* SEARCH(.*)$/i)
    if (m) {
      for (const tok of (m[1] ?? '').trim().split(/\s+/)) {
        const n = Number(tok)
        if (Number.isInteger(n) && n > 0) uids.push(n)
      }
    }
  }
  return uids
}

export function parseFetchMessages(buf: string): Array<{ uid: number; raw: string }> {
  const out: Array<{ uid: number; raw: string }> = []
  const open = /\* \d+ FETCH \(/g
  let mm: RegExpExecArray | null
  while ((mm = open.exec(buf)) !== null) {
    let i = mm.index + mm[0].length
    let depth = 1
    let uid: number | null = null
    let raw: string | null = null
    while (i < buf.length && depth > 0) {
      if (buf[i] === '{') {
        const close = buf.indexOf('}', i)
        if (close === -1) break
        const len = Number(buf.slice(i + 1, close))
        // A non-numeric/negative {n} -> NaN -> lastIndex resets to 0 -> the same
        // FETCH re-matches forever (a synchronous loop the poll timeout can't break).
        if (!Number.isInteger(len) || len < 0) break
        const dataStart = close + 1 + 2 // skip "}\r\n"
        raw = buf.slice(dataStart, dataStart + len)
        i = dataStart + len
        continue
      }
      if (buf.startsWith('UID ', i)) {
        const m2 = buf.slice(i).match(/^UID (\d+)/)
        if (m2) {
          uid = Number(m2[1])
          i += m2[0].length
          continue
        }
      }
      if (buf[i] === '(') depth++
      else if (buf[i] === ')') depth--
      i++
    }
    if (uid !== null && raw !== null) out.push({ uid, raw })
    open.lastIndex = i
  }
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export function imapSearchDate(d: Date): string {
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}

// The framers run on a "binary string" (1 code unit per wire octet) so a literal's
// {n} octet count equals n code units. Build the buffer latin1-style, NOT as
// UTF-8 — UTF-8 collapses multi-byte chars and every literal length would over-run.
export function bytesToBinary(bytes: Uint8Array): string {
  let s = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return s
}

export function binaryToUtf8(binary: string): string {
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)))
}
