import { describe, it, expect } from 'vitest'
import {
  imapResponseEnd,
  imapTaggedStatus,
  parseUidSearch,
  parseFetchMessages,
  imapSearchDate,
  bytesToBinary,
  binaryToUtf8,
} from './imap'

describe('imapResponseEnd', () => {
  it('returns null until the tagged line arrives', () => {
    expect(imapResponseEnd('* OK ready\r\n', 'a1')).toBeNull()
    expect(imapResponseEnd('* OK ready\r\na1 OK done\r\n', 'a1')).toBe('* OK ready\r\na1 OK done\r\n'.length)
  })

  it('skips a literal whose payload contains a fake tagged line', () => {
    // The literal body literally contains "a1 OK" + CRLF — must not be mistaken
    // for the real completion, which is the trailing "a1 OK FETCH done".
    const lit = 'a1 OK not-the-end\r\nmore'
    const buf = `* 1 FETCH (UID 5 BODY[] {${lit.length}}\r\n${lit})\r\na1 OK FETCH done\r\n`
    const end = imapResponseEnd(buf, 'a1')
    expect(end).toBe(buf.length)
  })

  it('returns null when a literal is not fully received', () => {
    const buf = '* 1 FETCH (UID 5 BODY[] {50}\r\nonly-a-few-bytes'
    expect(imapResponseEnd(buf, 'a1')).toBeNull()
  })
})

describe('imapTaggedStatus', () => {
  it('reads OK/NO/BAD on the tagged line', () => {
    expect(imapTaggedStatus('a2 OK done\r\n', 'a2')).toBe('OK')
    expect(imapTaggedStatus('* 1 EXISTS\r\na2 NO bad creds\r\n', 'a2')).toBe('NO')
    expect(imapTaggedStatus('a2 BAD syntax\r\n', 'a2')).toBe('BAD')
    expect(imapTaggedStatus('a2 OK\r\n', 'a3')).toBeNull()
  })

  it('ignores a forged tagged-status line inside a fetched literal body', () => {
    // The message body contains "a4 NO pwned" — must not be read as the FETCH
    // status; the genuine completion is the trailing "a4 OK".
    const lit = 'Subject: x\r\n\r\na4 NO pwned\r\n'
    const buf = `* 1 FETCH (UID 5 BODY[] {${lit.length}}\r\n${lit})\r\na4 OK FETCH done\r\n`
    expect(imapTaggedStatus(buf, 'a4')).toBe('OK')
  })
})

describe('parseUidSearch', () => {
  it('collects uids and tolerates an empty result', () => {
    expect(parseUidSearch('* SEARCH 12 13 99\r\na1 OK\r\n')).toEqual([12, 13, 99])
    expect(parseUidSearch('* SEARCH\r\na1 OK\r\n')).toEqual([])
  })
})

describe('parseFetchMessages', () => {
  it('extracts uid + raw for each FETCH, even across multiple messages', () => {
    const m1 = 'From: a@b.com\r\n\r\nhi'
    const m2 = 'From: c@d.com\r\n\r\nyo'
    const buf =
      `* 1 FETCH (UID 5 BODY[] {${m1.length}}\r\n${m1})\r\n` +
      `* 2 FETCH (UID 8 BODY[] {${m2.length}}\r\n${m2})\r\n` +
      `a1 OK FETCH completed\r\n`
    expect(parseFetchMessages(buf)).toEqual([
      { uid: 5, raw: m1 },
      { uid: 8, raw: m2 },
    ])
  })

  it('reads a partial-fetch BODY[]<0> literal the same as a full BODY[]', () => {
    const m = 'From: a@b.com\r\n\r\nhi'
    const buf = `* 1 FETCH (UID 5 BODY[]<0> {${m.length}}\r\n${m})\r\na1 OK\r\n`
    expect(parseFetchMessages(buf)).toEqual([{ uid: 5, raw: m }])
  })

  it('captures a raw message that itself contains parentheses', () => {
    const m = 'Subject: re (urgent) :)\r\n\r\nbody )('
    const buf = `* 1 FETCH (UID 3 BODY[] {${m.length}}\r\n${m})\r\na1 OK\r\n`
    expect(parseFetchMessages(buf)).toEqual([{ uid: 3, raw: m }])
  })

  it('terminates (no infinite loop) on a non-numeric or negative literal length', () => {
    // Before the guard, Number('abc') = NaN reset the regex lastIndex to 0 and the
    // same FETCH re-matched forever; these must return a bounded result instead.
    expect(parseFetchMessages('* 1 FETCH (UID 5 BODY[] {abc}\r\nx)\r\na1 OK\r\n')).toEqual([])
    expect(parseFetchMessages('* 1 FETCH (UID 5 BODY[] {-5}\r\nx)\r\na1 OK\r\n')).toEqual([])
  })
})

describe('byte-accurate literal framing', () => {
  // {N} is an octet count; the framer runs on a binary string (1 code unit per
  // wire byte), so a 3-byte char must consume 3 positions, not 1. A UTF-8-decoded
  // buffer would collapse them and every literal length would over-run.
  it('frames a literal by octet count over multi-byte UTF-8 content', () => {
    const body = 'Subject: hi\r\n\r\nこんにちは'
    const bytes = new TextEncoder().encode(body)
    const wire =
      `* 1 FETCH (UID 9 BODY[] {${bytes.length}}\r\n${bytesToBinary(bytes)})\r\n` +
      `a1 OK FETCH completed\r\n`
    const msgs = parseFetchMessages(wire)
    expect(msgs.length).toBe(1)
    expect(msgs[0]?.uid).toBe(9)
    expect(binaryToUtf8(msgs[0]?.raw ?? '')).toBe(body)
  })

  it('reports completeness by octet length, not code units', () => {
    const bytes = new TextEncoder().encode('ありがとうございます')
    const wire = `* 1 FETCH (UID 2 BODY[] {${bytes.length}}\r\n${bytesToBinary(bytes)})\r\na1 OK\r\n`
    expect(imapResponseEnd(wire, 'a1')).toBe(wire.length)
    const partial = `* 1 FETCH (UID 2 BODY[] {${bytes.length}}\r\n${bytesToBinary(bytes)}`
    expect(imapResponseEnd(partial, 'a1')).toBeNull()
  })

  it('round-trips bytes through the binary-string representation', () => {
    const bytes = new TextEncoder().encode('café — 日本語 🚀')
    expect(binaryToUtf8(bytesToBinary(bytes))).toBe('café — 日本語 🚀')
  })
})

describe('imapSearchDate', () => {
  it('formats a non-zero-padded IMAP date in UTC', () => {
    expect(imapSearchDate(new Date('2026-01-05T23:00:00Z'))).toBe('5-Jan-2026')
    expect(imapSearchDate(new Date('2026-12-31T12:00:00Z'))).toBe('31-Dec-2026')
  })
})
