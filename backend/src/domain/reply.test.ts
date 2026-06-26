import { describe, it, expect } from 'vitest'
import {
  attributeReply,
  normalizeEmailForMatch,
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
  ...over,
})

const cand = (id: number, email: string, sentAt: string): OutreachCandidate => ({
  outreachLogId: id,
  prospectEmail: email,
  sentAt: new Date(sentAt),
})

// Trusted poll time the ingest passes; attribution windows against this, not the
// sender-controlled Date header.
const NOW = new Date('2026-06-10T12:00:00Z')

describe('normalizeEmailForMatch', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmailForMatch('  Lead@Acme.COM ')).toBe('lead@acme.com')
  })
})

const captured = (raw: string, receivedAt = new Date('2026-06-10T12:00:00Z')): CapturedReply => ({
  email: parseEmailMessage(raw),
  receivedAt,
})

describe('toInboundReply', () => {
  it('pulls message-id, bare from, subject and body out of a captured reply', () => {
    const out = toInboundReply(
      captured('Message-ID: <m1@acme.com>\r\nFrom: Lead Person <lead@acme.com>\r\nSubject: Re: hi\r\n\r\nsure, lets talk'),
    )
    expect(out).toEqual({
      messageId: '<m1@acme.com>',
      fromEmail: 'lead@acme.com',
      subject: 'Re: hi',
      bodyText: 'sure, lets talk',
      receivedAt: new Date('2026-06-10T12:00:00Z'),
    })
  })

  it('keeps subject null when the header is absent', () => {
    const out = toInboundReply(captured('Message-ID: <m2@acme.com>\r\nFrom: lead@acme.com\r\n\r\nhi'))
    expect(out?.subject).toBeNull()
  })

  it('returns null without a Message-ID (no idempotency key)', () => {
    expect(toInboundReply(captured('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nhi'))).toBeNull()
  })

  it('returns null without a From (nothing to attribute)', () => {
    expect(toInboundReply(captured('Message-ID: <m3@acme.com>\r\nSubject: Re: hi\r\n\r\nhi'))).toBeNull()
  })
})

describe('attributeReply', () => {
  it('picks the most recent send to the matching sender within the window', () => {
    const out = attributeReply(reply(), [
      cand(1, 'lead@acme.com', '2026-06-01T00:00:00Z'),
      cand(2, 'lead@acme.com', '2026-06-08T00:00:00Z'),
      cand(3, 'other@acme.com', '2026-06-09T00:00:00Z'),
    ], 30, NOW)
    expect(out).toBe(2)
  })

  it('matches the sender case-insensitively', () => {
    const out = attributeReply(reply({ fromEmail: 'LEAD@acme.com' }), [
      cand(1, 'lead@acme.com', '2026-06-08T00:00:00Z'),
    ], 30, NOW)
    expect(out).toBe(1)
  })

  it('ignores sends dated after the poll time (future-dated row)', () => {
    const out = attributeReply(reply(), [
      cand(1, 'lead@acme.com', '2026-06-05T00:00:00Z'),
      cand(2, 'lead@acme.com', '2026-06-20T00:00:00Z'), // after NOW
    ], 30, NOW)
    expect(out).toBe(1)
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
    expect(attributeReply(reply(), [a, b], 30, NOW)).toBe(9)
    expect(attributeReply(reply(), [b, a], 30, NOW)).toBe(9)
  })
})
