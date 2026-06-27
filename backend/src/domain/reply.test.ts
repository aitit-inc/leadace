import { describe, it, expect } from 'vitest'
import {
  attributeReply,
  bounceMatchesFinalRecipient,
  normalizeEmailForMatch,
  normalizeMessageId,
  toInboundReply,
  type CapturedReply,
  type InboundReply,
  type OutreachCandidate,
} from './reply'
import { parseEmailMessage } from './email-message'

const reply = (over: Partial<InboundReply> = {}): InboundReply => ({
  messageId: '<m@x>',
  fromEmail: 'lead@acme.com',
  subject: 'Re: hello',
  bodyText: 'sure',
  receivedAt: new Date('2026-06-10T12:00:00Z'),
  referencedMessageIds: [],
  dsn: null,
  ...over,
})

const cand = (
  id: number,
  email: string,
  sentAt: string,
  messageId: string | null = null,
): OutreachCandidate => ({
  outreachLogId: id,
  prospectEmail: email,
  sentAt: new Date(sentAt),
  messageId,
})

// Trusted poll time the ingest passes; attribution windows against this, not the
// sender-controlled Date header.
const NOW = new Date('2026-06-10T12:00:00Z')

describe('normalizeEmailForMatch', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmailForMatch('  Lead@Acme.COM ')).toBe('lead@acme.com')
  })
})

describe('normalizeMessageId', () => {
  it('strips angle brackets, trims, and lowercases the domain drift', () => {
    expect(normalizeMessageId('  <ABC@Host.COM> ')).toBe('abc@host.com')
    expect(normalizeMessageId('abc@host.com')).toBe('abc@host.com')
  })
})

const captured = (raw: string, receivedAt = new Date('2026-06-10T12:00:00Z')): CapturedReply => ({
  email: parseEmailMessage(raw),
  receivedAt,
  dsn: null,
})

describe('toInboundReply', () => {
  it('pulls message-id, bare from, subject, body, and threading refs', () => {
    const out = toInboundReply(
      captured(
        'Message-ID: <m1@acme.com>\r\n' +
          'From: Lead Person <lead@acme.com>\r\n' +
          'Subject: Re: hi\r\n' +
          'In-Reply-To: <orig@surpassone.com>\r\n' +
          'References: <root@surpassone.com> <orig@surpassone.com>\r\n' +
          '\r\nsure, lets talk',
      ),
    )
    expect(out).toEqual({
      messageId: '<m1@acme.com>',
      fromEmail: 'lead@acme.com',
      subject: 'Re: hi',
      bodyText: 'sure, lets talk',
      receivedAt: new Date('2026-06-10T12:00:00Z'),
      referencedMessageIds: ['<orig@surpassone.com>', '<root@surpassone.com>', '<orig@surpassone.com>'],
      dsn: null,
    })
  })

  it('folds a DSN returned-original Message-ID into the threading refs', () => {
    const cap: CapturedReply = {
      email: parseEmailMessage('Message-ID: <dsn@daemon>\r\nFrom: mailer-daemon@googlemail.com\r\n\r\nfailed'),
      receivedAt: new Date('2026-06-10T12:00:00Z'),
      dsn: { finalRecipients: ['gone@dead.example'], originalMessageId: '<orig@surpassone.com>' },
    }
    expect(toInboundReply(cap)?.referencedMessageIds).toEqual(['<orig@surpassone.com>'])
  })

  it('returns null without a Message-ID (no idempotency key)', () => {
    expect(toInboundReply(captured('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nhi'))).toBeNull()
  })

  it('returns null without a From (nothing to attribute)', () => {
    expect(toInboundReply(captured('Message-ID: <m3@acme.com>\r\nSubject: Re: hi\r\n\r\nhi'))).toBeNull()
  })
})

describe('attributeReply — sender-recency fallback', () => {
  it('picks the most recent send to the matching sender within the window', () => {
    const out = attributeReply(reply(), [
      cand(1, 'lead@acme.com', '2026-06-01T00:00:00Z'),
      cand(2, 'lead@acme.com', '2026-06-08T00:00:00Z'),
      cand(3, 'other@acme.com', '2026-06-09T00:00:00Z'),
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 2, binding: 'sender' })
  })

  it('matches the sender case-insensitively', () => {
    const out = attributeReply(reply({ fromEmail: 'LEAD@acme.com' }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z'),
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'sender' })
  })

  it('ignores sends dated after the poll time (future-dated row)', () => {
    const out = attributeReply(reply(), [
      cand(1, 'lead@acme.com', '2026-06-05T00:00:00Z'),
      cand(2, 'lead@acme.com', '2026-06-20T00:00:00Z'), // after NOW
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'sender' })
  })

  it('ignores sends older than the window', () => {
    const out = attributeReply(reply(), [
      cand(1, 'lead@acme.com', '2026-04-01T00:00:00Z'), // > 30d before NOW
    ], 30, NOW)
    expect(out).toBeNull()
  })

  it('returns null when no sender matches', () => {
    const out = attributeReply(reply({ fromEmail: 'stranger@nope.com' }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z'),
    ], 30, NOW)
    expect(out).toBeNull()
  })

  it('breaks an equal-sentAt tie by the later outreach id, regardless of order', () => {
    const a = cand(5, 'lead@acme.com', '2026-06-08T00:00:00Z')
    const b = cand(9, 'lead@acme.com', '2026-06-08T00:00:00Z')
    expect(attributeReply(reply(), [a, b], 30, NOW)).toEqual({ outreachLogId: 9, binding: 'sender' })
    expect(attributeReply(reply(), [b, a], 30, NOW)).toEqual({ outreachLogId: 9, binding: 'sender' })
  })
})

describe('attributeReply — threading', () => {
  it('matches a referenced Message-ID to a sent outreach (binding: threaded)', () => {
    const out = attributeReply(reply({ referencedMessageIds: ['<orig@surpassone.com>'] }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z', '<orig@surpassone.com>'),
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'threaded' })
  })

  it('prefers a threaded match over a more-recent sender-recency match', () => {
    const out = attributeReply(reply({ referencedMessageIds: ['<orig@surpassone.com>'] }), [
      cand(1, 'lead@acme.com', '2026-06-01T00:00:00Z', '<orig@surpassone.com>'), // older, threaded
      cand(2, 'lead@acme.com', '2026-06-09T00:00:00Z', '<other@surpassone.com>'), // newer, same sender
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'threaded' })
  })

  it('attributes a daemon bounce whose From matches nobody, via the threaded original id', () => {
    const out = attributeReply(
      reply({ fromEmail: 'mailer-daemon@googlemail.com', referencedMessageIds: ['<orig@surpassone.com>'] }),
      [cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z', '<orig@surpassone.com>')],
      30,
      NOW,
    )
    expect(out).toEqual({ outreachLogId: 1, binding: 'threaded' })
  })

  it('tolerates angle-bracket / case differences between the reference and stored id', () => {
    const out = attributeReply(reply({ referencedMessageIds: ['<ORIG@Surpassone.com>'] }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z', '<orig@surpassone.com>'),
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'threaded' })
  })

  it('falls back to sender-recency when the referenced id matches no send', () => {
    const out = attributeReply(reply({ referencedMessageIds: ['<unknown@x>'] }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z', '<orig@surpassone.com>'),
    ], 30, NOW)
    expect(out).toEqual({ outreachLogId: 1, binding: 'sender' })
  })

  it('does not thread to an out-of-window send even on an id match', () => {
    const out = attributeReply(
      reply({ fromEmail: 'mailer-daemon@googlemail.com', referencedMessageIds: ['<orig@surpassone.com>'] }),
      [cand(1, 'lead@acme.com', '2026-04-01T00:00:00Z', '<orig@surpassone.com>')], // > 30d
      30,
      NOW,
    )
    expect(out).toBeNull()
  })
})

describe('bounceMatchesFinalRecipient (A-vs-C recall instrumentation)', () => {
  it('true when a Final-Recipient matches a recent send in window (case-insensitive)', () => {
    expect(
      bounceMatchesFinalRecipient(['Gone@Dead.example'], [cand(1, 'gone@dead.example', '2026-06-08T00:00:00Z')], 30, NOW),
    ).toBe(true)
  })

  it('false when no Final-Recipient matches any send', () => {
    expect(
      bounceMatchesFinalRecipient(['gone@dead.example'], [cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z')], 30, NOW),
    ).toBe(false)
  })

  it('false when the matching send is outside the window', () => {
    expect(
      bounceMatchesFinalRecipient(['gone@dead.example'], [cand(1, 'gone@dead.example', '2026-04-01T00:00:00Z')], 30, NOW),
    ).toBe(false)
  })

  it('false for an empty Final-Recipient list', () => {
    expect(bounceMatchesFinalRecipient([], [cand(1, 'gone@dead.example', '2026-06-08T00:00:00Z')], 30, NOW)).toBe(false)
  })
})
