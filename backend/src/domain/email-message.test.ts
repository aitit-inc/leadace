import { describe, it, expect } from 'vitest'
import { parseEmailMessage, getHeader, parseAddress, decodeQuotedPrintable, decodeBase64 } from './email-message'

describe('parseAddress', () => {
  it('extracts the bare address from a display-name form or returns it as-is', () => {
    expect(parseAddress('Lead Person <lead@acme.com>')).toBe('lead@acme.com')
    expect(parseAddress('  bare@acme.com ')).toBe('bare@acme.com')
  })

  it('prefers the last angle-addr containing "@" when the display name has brackets', () => {
    expect(parseAddress('"Foo <inner>" <real@acme.com>')).toBe('real@acme.com')
    expect(parseAddress('Sales <noreply@x.com> <real@acme.com>')).toBe('real@acme.com')
  })

  it('extracts the addr-spec from the legacy "addr (comment)" form', () => {
    expect(parseAddress('lead@acme.com (Lead Person)')).toBe('lead@acme.com')
    expect(parseAddress('(Lead Person) lead@acme.com')).toBe('lead@acme.com')
  })

  it('stays linear on adversarial input (no ReDoS)', () => {
    // A long run with no '@' (and the trailing-'@' variant) drove the prior
    // `X+@X+` fallback regex into quadratic backtracking; the linear scan must
    // return promptly. If this regressed, the test would hang, not fail slowly.
    const run = 'a'.repeat(50000)
    expect(parseAddress(run)).toBe(run)
    expect(parseAddress(`${run}@`)).toBe(`${run}@`)
  })
})

describe('decodeQuotedPrintable', () => {
  it('decodes hex escapes and soft breaks', () => {
    expect(decodeQuotedPrintable('caf=C3=A9')).toBe('café')
    expect(decodeQuotedPrintable('a very long li=\r\nne')).toBe('a very long line')
  })
})

describe('decodeBase64', () => {
  it('decodes utf-8 base64, tolerating embedded CRLF', () => {
    expect(decodeBase64('aGVsbG8gd29ybGQ=')).toBe('hello world')
    expect(decodeBase64('aGVsbG8g\r\nd29ybGQ=')).toBe('hello world')
  })
})

describe('parseEmailMessage', () => {
  it('parses headers (lowercased, unfolded) and a plain body', () => {
    const raw = [
      'From: Lead <lead@acme.com>',
      'Subject: Re: hi',
      'Message-ID: <abc@acme.com>',
      'Content-Type: text/plain',
      '',
      'Sounds good, let us talk.',
    ].join('\r\n')
    const m = parseEmailMessage(raw)
    expect(getHeader(m.headers, 'From')).toBe('Lead <lead@acme.com>')
    expect(getHeader(m.headers, 'message-id')).toBe('<abc@acme.com>')
    expect(m.bodyText).toBe('Sounds good, let us talk.')
  })

  it('unfolds a continuation header line', () => {
    const raw = 'Subject: a long\r\n subject line\r\n\r\nbody'
    expect(getHeader(parseEmailMessage(raw).headers, 'subject')).toBe('a long subject line')
  })

  it('decodes a quoted-printable body', () => {
    const raw = 'Content-Transfer-Encoding: quoted-printable\r\nContent-Type: text/plain\r\n\r\nMerci =C3=A9'
    expect(parseEmailMessage(raw).bodyText).toBe('Merci é')
  })

  it('prefers the text/plain part of a multipart/alternative body', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      '',
      'plain version',
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>html version</p>',
      '--b1--',
    ].join('\r\n')
    expect(parseEmailMessage(raw).bodyText).toBe('plain version')
  })

  it('prefers text/plain even when the html part comes first', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>html version</p>',
      '--b1',
      'Content-Type: text/plain',
      '',
      'plain version',
      '--b1--',
    ].join('\r\n')
    expect(parseEmailMessage(raw).bodyText).toBe('plain version')
  })

  it('decodes a base64 text/plain part inside a multipart body', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      '',
      'aGVsbG8gd29ybGQ=',
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>hi</p>',
      '--b1--',
    ].join('\r\n')
    expect(parseEmailMessage(raw).bodyText).toBe('hello world')
  })

  it('does not overflow the stack on a deeply nested multipart message', () => {
    let raw = 'deep body'
    for (let i = 0; i < 2000; i++) {
      const b = `b${i}`
      raw = [`Content-Type: multipart/mixed; boundary="${b}"`, '', `--${b}`, raw, `--${b}--`].join('\r\n')
    }
    expect(() => parseEmailMessage(raw)).not.toThrow()
    expect(typeof parseEmailMessage(raw).bodyText).toBe('string')
  })

  it('falls back to the first part when no text/plain part exists', () => {
    const raw = [
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html',
      '',
      '<p>only html</p>',
      '--b1--',
    ].join('\r\n')
    expect(parseEmailMessage(raw).bodyText).toBe('<p>only html</p>')
  })

  it('tolerates only LF line endings', () => {
    const m = parseEmailMessage('From: a@b.com\nSubject: x\n\nhello')
    expect(getHeader(m.headers, 'from')).toBe('a@b.com')
    expect(m.bodyText).toBe('hello')
  })
})
