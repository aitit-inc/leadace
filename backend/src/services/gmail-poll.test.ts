import { describe, it, expect } from 'vitest'
import { gmailAfter, extractBody, flattenGmailParts, type GmailPart } from './gmail-poll'
import { parseDsn } from '../domain/dsn'

function b64url(text: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(text)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// Gmail search wants `after:YYYY/M/D` in UTC, NOT zero-padded — distinct from the
// IMAP `D-Mon-YYYY` form (domain/imap imapSearchDate). A wrong format makes Gmail
// silently ignore the date filter, widening or voiding the poll window.
describe('gmailAfter', () => {
  it('formats UTC year/month/day with no zero-padding', () => {
    expect(gmailAfter(new Date('2026-01-05T23:00:00Z'))).toBe('2026/1/5')
    expect(gmailAfter(new Date('2026-12-31T12:00:00Z'))).toBe('2026/12/31')
  })

  it('uses UTC components, not local time', () => {
    expect(gmailAfter(new Date('2026-03-09T23:30:00Z'))).toBe('2026/3/9')
  })

  it('passes a leap day through', () => {
    expect(gmailAfter(new Date('2028-02-29T00:00:00Z'))).toBe('2028/2/29')
  })
})

// Must match the IMAP arm's text/plain preference (domain/email-message.test.ts).
describe('extractBody (gmail tree)', () => {
  it('prefers the text/plain part of a multipart/alternative body', () => {
    const body = extractBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain version') } },
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
      ],
    })
    expect(body).toBe('plain version')
  })

  it('prefers text/plain even when the html part comes first', () => {
    const body = extractBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64url('<p>html version</p>') } },
        { mimeType: 'text/plain', body: { data: b64url('plain version') } },
      ],
    })
    expect(body).toBe('plain version')
  })

  it('finds text/plain nested under a multipart/mixed with an attachment', () => {
    const body = extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url('the reply') } },
            { mimeType: 'text/html', body: { data: b64url('<p>the reply</p>') } },
          ],
        },
        { mimeType: 'application/pdf', body: { data: b64url('PDFDATA') } },
      ],
    })
    expect(body).toBe('the reply')
  })

  it('falls back to the first part when no text/plain part exists', () => {
    const body = extractBody({
      mimeType: 'multipart/alternative',
      parts: [{ mimeType: 'text/html', body: { data: b64url('<p>only html</p>') } }],
    })
    expect(body).toBe('<p>only html</p>')
  })

  it('decodes a single text/plain leaf payload, trimmed like the IMAP arm', () => {
    expect(extractBody({ mimeType: 'text/plain', body: { data: b64url('  hello world \r\n') } })).toBe('hello world')
  })

  it('bounds recursion depth on a deeply nested payload', () => {
    let part: GmailPart = { mimeType: 'text/plain', body: { data: b64url('deep') } }
    for (let i = 0; i < 5000; i++) part = { mimeType: 'multipart/mixed', parts: [part] }
    expect(() => extractBody(part)).not.toThrow()
    expect(typeof extractBody(part)).toBe('string')
  })
})

// Validates the Gmail bounce shape: a message/rfc822 node whose first child
// carries the returned original's headers (incl. Message-ID). flattenGmailParts
// surfaces those onto the rfc822 part so parseDsn can read the trusted bounce key.
describe('flattenGmailParts -> parseDsn (Gmail bounce tree)', () => {
  const payload: GmailPart = {
    mimeType: 'multipart/report',
    headers: [{ name: 'Message-ID', value: '<dsn-own@mail.gmail.com>' }],
    parts: [
      {
        mimeType: 'multipart/related',
        parts: [
          { mimeType: 'text/html', body: { data: b64url('<p>Address not found</p>') } },
          { mimeType: 'image/png', body: { data: b64url('PNGICON') } },
        ],
      },
      {
        mimeType: 'message/delivery-status',
        body: {
          data: b64url(
            'Reporting-MTA: dns; googlemail.com\r\n\r\n' +
              'Final-Recipient: rfc822; gone@dead.example\r\nAction: failed\r\nStatus: 5.1.1',
          ),
        },
      },
      {
        mimeType: 'message/rfc822',
        parts: [
          {
            mimeType: 'multipart/alternative',
            headers: [
              { name: 'From', value: 'sales@surpassone.com' },
              { name: 'Message-ID', value: '<orig-token@surpassone.com>' },
            ],
            parts: [{ mimeType: 'text/plain', body: { data: b64url('Hi there') } }],
          },
        ],
      },
    ],
  }

  it('extracts the final recipient and the returned original Message-ID', () => {
    const dsn = parseDsn(flattenGmailParts(payload))
    expect(dsn?.finalRecipients).toEqual(['gone@dead.example'])
    expect(dsn?.originalMessageId).toBe('<orig-token@surpassone.com>')
  })

  it('does not mistake the DSN own Message-ID for the original', () => {
    const dsn = parseDsn(flattenGmailParts(payload))
    expect(dsn?.originalMessageId).not.toBe('<dsn-own@mail.gmail.com>')
  })
})
