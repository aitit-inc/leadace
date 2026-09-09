import { describe, it, expect } from 'vitest'
import { parseDsnOriginalMessageId } from './dsn'
import { flattenMessageParts, type MessagePart } from './email-message'

// A realistic Gmail-shaped raw DSN: multipart/report with a human part, a
// message/delivery-status part, and a message/rfc822 part whose body is the
// returned original (carrying our Message-ID).
const RAW_DSN = [
  'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
  'To: sales@surpassone.com',
  'Subject: Delivery Status Notification (Failure)',
  'Content-Type: multipart/report; report-type=delivery-status; boundary="BOUND"',
  '',
  '--BOUND',
  'Content-Type: text/plain; charset=UTF-8',
  '',
  "Address not found. Your message wasn't delivered to support@onvoyage.ai.",
  '--BOUND',
  'Content-Type: message/delivery-status',
  '',
  'Reporting-MTA: dns; googlemail.com',
  '',
  'Final-Recipient: rfc822; support@onvoyage.ai',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
  '--BOUND',
  'Content-Type: message/rfc822',
  '',
  'From: sales@surpassone.com',
  'To: support@onvoyage.ai',
  'Subject: Saw your work',
  'Message-ID: <abc123def456@surpassone.com>',
  'Content-Type: text/plain',
  '',
  'Hi there, ...',
  '--BOUND--',
  '',
].join('\r\n')

describe('parseDsnOriginalMessageId (IMAP raw representation)', () => {
  it('extracts the returned original Message-ID', () => {
    expect(parseDsnOriginalMessageId(flattenMessageParts(RAW_DSN))).toBe('<abc123def456@surpassone.com>')
  })
})

describe('parseDsnOriginalMessageId (Gmail part representation)', () => {
  it('reads the original Message-ID from the rfc822 part headers', () => {
    const parts: MessagePart[] = [
      { mimeType: 'text/plain', headers: new Map(), body: 'Address not found' },
      {
        mimeType: 'message/delivery-status',
        headers: new Map(),
        body: 'Final-Recipient: rfc822; gone@dead.example\r\nAction: failed',
      },
      {
        mimeType: 'message/rfc822',
        headers: new Map([['message-id', '<xyz@surpassone.com>']]),
        body: '',
      },
    ]
    expect(parseDsnOriginalMessageId(parts)).toBe('<xyz@surpassone.com>')
  })

  it('reads the Message-ID from a text/rfc822-headers part body when no rfc822 part headers', () => {
    const parts: MessagePart[] = [
      {
        mimeType: 'message/delivery-status',
        headers: new Map(),
        body: 'Final-Recipient: rfc822; gone@dead.example',
      },
      {
        mimeType: 'text/rfc822-headers',
        headers: new Map(),
        body: 'From: us@x.com\r\nMessage-ID: <hdrs-only@x.com>\r\n',
      },
    ]
    expect(parseDsnOriginalMessageId(parts)).toBe('<hdrs-only@x.com>')
  })
})

describe('parseDsnOriginalMessageId (non-DSN)', () => {
  it('returns null for an ordinary message with no machine-readable bounce parts', () => {
    const parts: MessagePart[] = [
      { mimeType: 'text/plain', headers: new Map(), body: 'just a reply' },
    ]
    expect(parseDsnOriginalMessageId(parts)).toBeNull()
  })

  it('returns null for a report that carries no returned original', () => {
    const parts: MessagePart[] = [
      { mimeType: 'message/delivery-status', headers: new Map(), body: 'Status: 2.0.0' },
    ]
    expect(parseDsnOriginalMessageId(parts)).toBeNull()
  })
})
