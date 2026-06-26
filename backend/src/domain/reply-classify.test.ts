import { describe, it, expect } from 'vitest'
import { parseEmailMessage } from './email-message'
import { detectDeterministicType } from './reply-classify'

const classify = (raw: string) => detectDeterministicType(parseEmailMessage(raw))

describe('detectDeterministicType', () => {
  it('flags a DSN delivery-status report as a bounce', () => {
    const raw = 'From: Mail Delivery System <MAILER-DAEMON@mx.acme.com>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="b"\r\n\r\n...'
    expect(classify(raw)).toBe('bounce')
  })

  it('flags a postmaster sender as a bounce', () => {
    expect(classify('From: postmaster@acme.com\r\nSubject: Undeliverable\r\n\r\nx')).toBe('bounce')
  })

  it('flags a bare mailer-daemon sender (no report content-type) as a bounce', () => {
    expect(classify('From: Mail Delivery System <mailer-daemon@mx.acme.com>\r\nSubject: failure notice\r\n\r\nx')).toBe('bounce')
  })

  it('flags an X-Failed-Recipients header as a bounce', () => {
    expect(classify('From: lead@acme.com\r\nX-Failed-Recipients: nobody@acme.com\r\nSubject: Re: hi\r\n\r\nx')).toBe('bounce')
  })

  it('flags an X-Autoreply header as an auto-reply', () => {
    expect(classify('From: lead@acme.com\r\nX-Autoreply: yes\r\nSubject: Re: hi\r\n\r\nx')).toBe('auto_reply')
  })

  it('flags an "Automatic reply" subject as an auto-reply', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Automatic reply: your email\r\n\r\nx')).toBe('auto_reply')
  })

  it('flags Auto-Submitted as an auto-reply', () => {
    expect(classify('From: lead@acme.com\r\nAuto-Submitted: auto-replied\r\n\r\nx')).toBe('auto_reply')
  })

  it('flags an out-of-office subject as an auto-reply', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Out of Office: Re: hi\r\n\r\nx')).toBe('auto_reply')
  })

  it('does not flag Auto-Submitted: no', () => {
    expect(classify('From: lead@acme.com\r\nAuto-Submitted: no\r\nSubject: Re: hi\r\n\r\nx')).toBeNull()
  })

  it('returns null for a genuine human reply (hand to the LLM)', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: your email\r\n\r\nYes interested')).toBeNull()
  })
})
