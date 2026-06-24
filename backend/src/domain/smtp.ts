// Pure SMTP protocol framing (no I/O) — the TCP session lives in smtp-send.ts.
const enc = new TextEncoder()

// Final reply line is "NNN " (space, not "NNN-"); returns its end, or null if
// the buffer holds no complete reply yet.
export function smtpReplyEnd(buf: string): number | null {
  let idx = 0
  for (;;) {
    const nl = buf.indexOf('\r\n', idx)
    if (nl === -1) return null
    if (/^\d{3} /.test(buf.slice(idx, nl))) return nl + 2
    idx = nl + 2
  }
}

export function smtpReplyCode(reply: string): number {
  return Number(reply.slice(0, 3))
}

export function encodeBase64(value: string): string {
  return btoa(String.fromCharCode(...enc.encode(value)))
}

// AUTH PLAIN blob: base64 of "\0username\0password" (RFC 4616).
export function encodeAuthPlain(username: string, password: string): string {
  return encodeBase64(`\0${username}\0${password}`)
}

export function parseAuthMechanisms(ehloReply: string): { plain: boolean; login: boolean } {
  const mechs = new Set<string>()
  for (const line of ehloReply.split('\r\n')) {
    // Accept both "AUTH PLAIN ..." (RFC 4954) and legacy "AUTH=PLAIN ..." (RFC 2554).
    const m = line.slice(4).match(/^AUTH[\s=]+(.+)$/i)
    if (m) for (const x of (m[1] ?? '').split(/\s+/)) mechs.add(x.toUpperCase())
  }
  return { plain: mechs.has('PLAIN'), login: mechs.has('LOGIN') }
}

// Quoted-printable (RFC 2045 §6.7) so an 8-bit UTF-8 body travels 7-bit-clean over
// raw SMTP DATA — works on any server, no 8BITMIME needed. '\n'/'\r'/CRLF all
// become CRLF; lines soft-wrap at 76 chars with "=\r\n".
export function quotedPrintableEncode(text: string): string {
  const hex = (b: number) => '=' + b.toString(16).toUpperCase().padStart(2, '0')
  const out: string[] = []
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    let line = ''
    // Append an atom, soft-wrapping so each physical line (incl. the '=') is <= 76.
    const emit = (atom: string) => {
      if (line.length + atom.length > 75) {
        out.push(line + '=')
        line = ''
      }
      line += atom
    }
    // Defer raw whitespace: a space/tab may stay literal only when a printable
    // follows it on the same line (RFC 2045 §6.7 #3 — no raw WS at line end, incl.
    // before a soft break). Emit it joined to that char so a wrap can't strand it;
    // encode it (=20/=09) at end of line or in a pathological long run.
    let ws = ''
    for (const b of enc.encode(rawLine)) {
      if (b === 0x20 || b === 0x09) {
        ws += String.fromCharCode(b)
        continue
      }
      const atom = b >= 0x21 && b <= 0x7e && b !== 0x3d ? String.fromCharCode(b) : hex(b)
      if (ws.length + atom.length <= 75) {
        emit(ws + atom)
      } else {
        for (const c of ws) emit(hex(c.charCodeAt(0)))
        emit(atom)
      }
      ws = ''
    }
    for (const c of ws) emit(hex(c.charCodeAt(0)))
    out.push(line)
  }
  return out.join('\r\n')
}

// Normalize to CRLF first (the body/footer carry bare '\n'), then dot-stuff
// leading dots (RFC 5321 §4.5.2 transparency) and append the "\r\n.\r\n"
// terminator. Normalizing before the split is what dot-stuffs a line after a bare '\n'.
export function dotStuffAndTerminate(rfc822: string): string {
  const stuffed = rfc822
    .replace(/\r\n|\r|\n/g, '\r\n')
    .split('\r\n')
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join('\r\n')
  const base = stuffed.endsWith('\r\n') ? stuffed : stuffed + '\r\n'
  return base + '.\r\n'
}

export function ehloDomainFor(from: string): string {
  const at = from.lastIndexOf('@')
  const domain = at >= 0 ? from.slice(at + 1).trim() : ''
  return domain || 'leadace'
}
