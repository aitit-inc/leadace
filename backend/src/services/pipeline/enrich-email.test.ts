import { describe, expect, it } from 'vitest'
import { mergeContactForm, pickEvidencedEmail } from './enrich'

const page = 'https://example.com/contact'

describe('pickEvidencedEmail', () => {
  it('prefers an address without a refusal notice over an earlier refused one', () => {
    const picked = pickEvidencedEmail(
      [
        { address: 'info@example.com', foundOnUrl: page, noSolicitation: true, salesContact: true },
        { address: 'partners@example.com', foundOnUrl: page, noSolicitation: false, salesContact: true },
      ],
      [page],
    )
    expect(picked?.address).toBe('partners@example.com')
  })
  it('keeps a refused address when it is the only evidenced one', () => {
    const picked = pickEvidencedEmail([{ address: 'info@example.com', foundOnUrl: page, noSolicitation: true, salesContact: true }], [page])
    expect(picked).toEqual({ address: 'info@example.com', foundOnUrl: page, noSolicitation: true, salesContact: true })
  })
  it('ignores an address whose page was not retrieved or that is not an address', () => {
    expect(pickEvidencedEmail([{ address: 'a@example.com', foundOnUrl: 'https://example.com/other', noSolicitation: false, salesContact: true }], [page])).toBeUndefined()
    expect(pickEvidencedEmail([{ address: 'not an email', foundOnUrl: page, noSolicitation: false, salesContact: true }], [page])).toBeUndefined()
  })
  it('keeps the notice an address carried on another page', () => {
    const picked = pickEvidencedEmail(
      [
        { address: 'info@example.com', foundOnUrl: page, noSolicitation: true, salesContact: true },
        { address: 'Info@example.com', foundOnUrl: 'https://example.com/about', noSolicitation: false, salesContact: true },
      ],
      [page, 'https://example.com/about'],
    )
    expect(picked?.noSolicitation).toBe(true)
  })
})

describe('pickEvidencedEmail and the sales-contact call', () => {
  it('skips an address the read judged not a sales contact, even when it came first', () => {
    const picked = pickEvidencedEmail(
      [
        { address: 'privacy@example.com', foundOnUrl: page, noSolicitation: false, salesContact: false },
        { address: 'info@example.com', foundOnUrl: page, noSolicitation: false, salesContact: true },
      ],
      [page],
    )
    expect(picked?.address).toBe('info@example.com')
    expect(pickEvidencedEmail([{ address: 'privacy@example.com', foundOnUrl: page, noSolicitation: false, salesContact: false }], [page])).toBeUndefined()
  })
  it('keeps a notice seen beside the same address where it was not judged a sales contact', () => {
    const picked = pickEvidencedEmail(
      [
        { address: 'info@example.com', foundOnUrl: 'https://example.com/privacy', noSolicitation: true, salesContact: false },
        { address: 'info@example.com', foundOnUrl: page, noSolicitation: false, salesContact: true },
      ],
      [page, 'https://example.com/privacy'],
    )
    expect(picked?.noSolicitation).toBe(true)
  })
})

describe('mergeContactForm', () => {
  const usable = { url: 'https://example.com/contact', formType: 'native_html' as const, noSolicitation: false, salesContact: true }
  const refused = { ...usable, noSolicitation: true, salesContact: true }
  const other = { url: 'https://example.com/business', formType: 'native_html' as const, noSolicitation: false, salesContact: true }
  it('keeps a notice either read saw on the same form', () => {
    expect(mergeContactForm(usable, refused)).toEqual(refused)
    expect(mergeContactForm(refused, usable)).toEqual(refused)
  })
  it('prefers a form without a notice over a refused one', () => {
    expect(mergeContactForm(refused, other)).toEqual(other)
    expect(mergeContactForm(usable, other)).toEqual(usable)
  })
  it('takes whichever read found one', () => {
    expect(mergeContactForm(null, other)).toEqual(other)
    expect(mergeContactForm(usable, null)).toEqual(usable)
  })
})
