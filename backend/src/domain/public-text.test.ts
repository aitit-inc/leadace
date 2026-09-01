import { describe, expect, it } from 'vitest'
import { findLinkOrContact } from './public-text'

describe('findLinkOrContact', () => {
  it('passes ordinary prose, versions, and file-ish tokens', () => {
    expect(findLinkOrContact('Sent 12 emails · Replies 1 (0 positive) · Bounces 2')).toBeNull()
    expect(findLinkOrContact('Node.js shops on v0.7.64, e.g. a 12-person dev tools company.')).toBeNull()
    expect(findLinkOrContact('Signed, **Ace**')).toBeNull()
  })

  it('flags links in every common spelling', () => {
    expect(findLinkOrContact('see https://example.com/x')).toBe('url')
    expect(findLinkOrContact('see www.example.com')).toBe('url')
    expect(findLinkOrContact('write to mailto:hi@example.com')).toBe('email')
    expect(findLinkOrContact('[docs](example.com)')).toBe('url')
  })

  it('flags email addresses, bare domains, and handles', () => {
    expect(findLinkOrContact('reach jane.doe+x@acme-corp.co')).toBe('email')
    expect(findLinkOrContact('a founder at acme.io said no')).toBe('domain')
    expect(findLinkOrContact('their site app.acme.dev is down')).toBe('domain')
    expect(findLinkOrContact('per @acme_hq on X')).toBe('handle')
  })
})
