import { describe, it, expect } from 'vitest'
import {
  smtpReplyEnd,
  smtpReplyCode,
  encodeAuthPlain,
  parseAuthMechanisms,
  quotedPrintableEncode,
  dotStuffAndTerminate,
  ehloDomainFor,
} from './smtp'

// atob yields a binary (Latin-1) string; decode the bytes back as UTF-8 to read
// the original credential text.
function b64ToUtf8(b64: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
}

describe('dotStuffAndTerminate', () => {
  it('doubles a leading dot so content cannot fake the DATA terminator', () => {
    const out = dotStuffAndTerminate('Hello\r\n.World\r\nBye')
    expect(out).toBe('Hello\r\n..World\r\nBye\r\n.\r\n')
  })

  it('escapes a line that is a bare dot', () => {
    expect(dotStuffAndTerminate('a\r\n.\r\nb')).toBe('a\r\n..\r\nb\r\n.\r\n')
  })

  it('does not double the CRLF when the message already ends in CRLF', () => {
    expect(dotStuffAndTerminate('A\r\n')).toBe('A\r\n.\r\n')
  })

  it('leaves non-dot lines untouched', () => {
    expect(dotStuffAndTerminate('one\r\ntwo')).toBe('one\r\ntwo\r\n.\r\n')
  })

  it('normalizes bare LF (and CR) to CRLF before the terminator', () => {
    expect(dotStuffAndTerminate('a\nb\r\nc\rd')).toBe('a\r\nb\r\nc\r\nd\r\n.\r\n')
  })

  it('dot-stuffs a line that follows a bare LF (the body/footer case)', () => {
    // Without CRLF normalization first, ".See" after a bare \n would slip through
    // un-stuffed and the receiver would eat the leading dot.
    expect(dotStuffAndTerminate('Hi\n.See site')).toBe('Hi\r\n..See site\r\n.\r\n')
  })
})

describe('encodeAuthPlain', () => {
  it('is base64 of \\0username\\0password (RFC 4616)', () => {
    expect(b64ToUtf8(encodeAuthPlain('user', 'pass'))).toBe('\0user\0pass')
  })

  it('round-trips UTF-8 credentials', () => {
    expect(b64ToUtf8(encodeAuthPlain('cold@ex.com', 'pä$$wörd'))).toBe('\0cold@ex.com\0pä$$wörd')
  })
})

describe('smtpReplyEnd / smtpReplyCode', () => {
  it('returns the length only once a final "NNN " line is present', () => {
    expect(smtpReplyEnd('250-FIRST\r\n')).toBeNull() // continuation only
    const full = '250-FIRST\r\n250 OK\r\n'
    expect(smtpReplyEnd(full)).toBe(full.length)
  })

  it('handles a single-line reply', () => {
    expect(smtpReplyEnd('220 hi\r\n')).toBe(8)
    expect(smtpReplyEnd('220 hi')).toBeNull() // no CRLF yet
  })

  it('reads the numeric code', () => {
    expect(smtpReplyCode('235 2.7.0 OK')).toBe(235)
    expect(smtpReplyCode('550 no')).toBe(550)
  })
})

describe('parseAuthMechanisms', () => {
  it('extracts PLAIN/LOGIN from a multiline EHLO reply', () => {
    expect(parseAuthMechanisms('250-host\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 100')).toEqual({
      plain: true,
      login: true,
    })
  })

  it('reports neither when only unsupported mechanisms are offered', () => {
    expect(parseAuthMechanisms('250-host\r\n250 AUTH XOAUTH2')).toEqual({ plain: false, login: false })
  })

  it('accepts the legacy "AUTH=" syntax (RFC 2554)', () => {
    expect(parseAuthMechanisms('250-host\r\n250 AUTH=PLAIN LOGIN')).toEqual({ plain: true, login: true })
  })
})

describe('quotedPrintableEncode', () => {
  it('leaves printable ASCII untouched', () => {
    expect(quotedPrintableEncode('Hello, world!')).toBe('Hello, world!')
  })

  it('encodes "=" as =3D so it can never be read as a soft break', () => {
    expect(quotedPrintableEncode('a=b')).toBe('a=3Db')
  })

  it('encodes multi-byte UTF-8 byte-by-byte (uppercase hex)', () => {
    // "あ" = E3 81 82 in UTF-8.
    expect(quotedPrintableEncode('あ')).toBe('=E3=81=82')
  })

  it('emits bare LF and CRLF alike as CRLF hard line breaks', () => {
    expect(quotedPrintableEncode('a\nb')).toBe('a\r\nb')
    expect(quotedPrintableEncode('a\r\nb')).toBe('a\r\nb')
  })

  it('encodes trailing whitespace at end of a line (=20) but not interior spaces', () => {
    expect(quotedPrintableEncode('a b ')).toBe('a b=20')
    expect(quotedPrintableEncode('a b\nc')).toBe('a b\r\nc')
  })

  it('soft-wraps long lines to <= 76 chars with =\\r\\n and never splits a triplet', () => {
    const out = quotedPrintableEncode('x'.repeat(80))
    for (const physical of out.split('\r\n')) expect(physical.length).toBeLessThanOrEqual(76)
    // Strip the soft breaks and the original text is recovered.
    expect(out.replace(/=\r\n/g, '')).toBe('x'.repeat(80))
  })

  it('never leaves raw whitespace before a soft break (RFC 2045 §6.7 #3)', () => {
    // A space landing exactly at the wrap boundary must not end an encoded line.
    const out = quotedPrintableEncode('a'.repeat(74) + ' ' + 'b'.repeat(10))
    for (const physical of out.split('\r\n')) {
      expect(physical).not.toMatch(/[ \t]$/)
      expect(physical.length).toBeLessThanOrEqual(76)
    }
    // Even a decoder that strips trailing whitespace per line round-trips exactly.
    const decoded = out
      .split('\r\n')
      .map((l) => l.replace(/[ \t]+$/, ''))
      .join('\r\n')
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    expect(decoded).toBe('a'.repeat(74) + ' ' + 'b'.repeat(10))
  })

  it('round-trips an 8-bit body (decode reproduces the source)', () => {
    const decodeQp = (s: string) =>
      s
        .replace(/=\r\n/g, '')
        .replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    const src = 'Hello 田中様、\nLeadAce のご案内です = テスト。'
    const bytes = Uint8Array.from(decodeQp(quotedPrintableEncode(src)), (c) => c.charCodeAt(0))
    expect(new TextDecoder().decode(bytes)).toBe(src.replace(/\n/g, '\r\n'))
  })
})

describe('ehloDomainFor', () => {
  it('uses the From domain, falling back to a literal', () => {
    expect(ehloDomainFor('cold@example.com')).toBe('example.com')
    expect(ehloDomainFor('no-at-sign')).toBe('leadace')
  })
})
