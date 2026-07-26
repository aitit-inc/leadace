import { describe, it, expect } from 'vitest'
import { parseEmailMessage } from './email-message'
import { detectDeterministicType, leadingUnquotedText } from './reply-classify'

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

  it('flags a top-line "Unsubscribe" reply as unsubscribe', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nUnsubscribe')).toBe('unsubscribe')
  })

  it('flags a top-line "配信停止" reply (with quoted history below) as unsubscribe', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n「配信停止」\r\n\r\nOn Mon someone wrote:\r\n> hello')).toBe('unsubscribe')
  })

  it('does NOT flag a positive reply that merely quotes our unsubscribe footer', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nYes, sounds good!\r\n\r\n> To unsubscribe, just reply with "unsubscribe".')).toBeNull()
  })

  it('leaves a free-form opt-out to the LLM', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nplease remove me from your list')).toBeNull()
  })

  it('flags a top-line "NOT ME" reply as micro_not_me (case-insensitive, punctuation stripped)', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nNot me.')).toBe('micro_not_me')
  })

  it('flags a top-line "担当違い" reply (with quoted history below) as micro_not_me', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n「担当違い」です\r\n\r\nOn Mon someone wrote:\r\n> hello')).toBeNull()
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n担当違い。\r\n\r\nOn Mon someone wrote:\r\n> hello')).toBe('micro_not_me')
  })

  it('flags a top-line "LATER" reply as micro_later', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nLATER')).toBe('micro_later')
  })

  it('flags a top-line "またの機会に。" reply as micro_later (fullwidth punctuation stripped)', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nまたの機会に。')).toBe('micro_later')
  })

  it('strips smart quotes and fullwidth period/comma (‘NOT ME’, 担当違い．)', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n‘NOT ME’')).toBe('micro_not_me')
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n担当違い．')).toBe('micro_not_me')
  })

  it('does not flag a sentence that merely starts with a token ("Later this week works")', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\nLater this week works')).toBeNull()
  })

  it('does NOT flag a reply that only quotes the escape-hatch line from our own email', () => {
    expect(classify('From: lead@acme.com\r\nSubject: Re: hi\r\n\r\n> Wrong person? Just reply "NOT ME". Bad timing? Reply "LATER".')).toBeNull()
  })
})

describe('leadingUnquotedText', () => {
  it('drops the quoted footer so the LLM never sees our own "unsubscribe" token', () => {
    expect(
      leadingUnquotedText('Yes, sounds good — let\'s talk.\r\n\r\n> To unsubscribe, just reply with "unsubscribe".'),
    ).toBe('Yes, sounds good — let\'s talk.')
  })

  it('keeps the whole body when nothing is quoted', () => {
    expect(leadingUnquotedText('please remove me from your list')).toBe('please remove me from your list')
  })

  it('returns empty when the reply is entirely quoted (nothing new above the quote)', () => {
    expect(leadingUnquotedText('> On Mon someone wrote:\r\n> unsubscribe')).toBe('')
  })

  it('preserves multi-line lead-in before the quote', () => {
    expect(leadingUnquotedText('Thanks!\r\nCan we meet next week?\r\n\r\n> quoted history')).toBe(
      'Thanks!\nCan we meet next week?',
    )
  })
})
