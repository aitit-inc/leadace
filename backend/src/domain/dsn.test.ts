import { describe, it, expect } from 'vitest'
import { parseDsn, parseFinalRecipients } from './dsn'
import { flattenMessageParts, type MessagePart } from './email-message'

// A realistic Gmail-shaped raw DSN: multipart/report with a human part, a
// message/delivery-status part (Final-Recipient), and a message/rfc822 part whose
// body is the returned original (carrying our Message-ID).
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

describe('parseFinalRecipients', () => {
  it('extracts and normalizes the failed address', () => {
    const status = 'Final-Recipient: rfc822; Support@Onvoyage.AI\r\nAction: failed'
    expect(parseFinalRecipients(status)).toEqual(['support@onvoyage.ai'])
  })

  it('tolerates angle brackets and collects multiple recipients', () => {
    const status = [
      'Final-Recipient: rfc822; <a@x.com>',
      'Final-Recipient: rfc822; b@y.com',
    ].join('\n')
    expect(parseFinalRecipients(status)).toEqual(['a@x.com', 'b@y.com'])
  })

  it('returns empty when no Final-Recipient line is present', () => {
    expect(parseFinalRecipients('Status: 5.1.1\r\nAction: failed')).toEqual([])
  })
})

describe('parseDsn (IMAP raw representation)', () => {
  it('extracts both final recipient and the returned original Message-ID', () => {
    const dsn = parseDsn(flattenMessageParts(RAW_DSN))
    expect(dsn).not.toBeNull()
    expect(dsn?.finalRecipients).toEqual(['support@onvoyage.ai'])
    expect(dsn?.originalMessageId).toBe('<abc123def456@surpassone.com>')
  })
})

describe('parseDsn (Gmail part representation)', () => {
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
    const dsn = parseDsn(parts)
    expect(dsn?.finalRecipients).toEqual(['gone@dead.example'])
    expect(dsn?.originalMessageId).toBe('<xyz@surpassone.com>')
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
    expect(parseDsn(parts)?.originalMessageId).toBe('<hdrs-only@x.com>')
  })
})

describe('parseDsn (non-DSN)', () => {
  it('returns null for an ordinary message with no machine-readable bounce parts', () => {
    const parts: MessagePart[] = [
      { mimeType: 'text/plain', headers: new Map(), body: 'just a reply' },
    ]
    expect(parseDsn(parts)).toBeNull()
  })

  it('returns null when a report part exists but carries neither recipient nor id', () => {
    const parts: MessagePart[] = [
      { mimeType: 'message/delivery-status', headers: new Map(), body: 'Status: 2.0.0' },
    ]
    expect(parseDsn(parts)).toBeNull()
  })
})
