import { describe, expect, it } from 'vitest'
import { inRetrieved } from './enrich'

describe('inRetrieved', () => {
  const retrieved = ['https://Example.com/News/A/']
  it('matches the retrieved page whatever the host case or a trailing slash', () => {
    expect(inRetrieved('https://example.com/News/A', retrieved)).toBe(true)
  })
  it('keeps path case — a page differing only in case is another page', () => {
    expect(inRetrieved('https://example.com/news/a', retrieved)).toBe(false)
  })
  it('rejects a page that was not retrieved', () => {
    expect(inRetrieved('https://example.com/News/B', retrieved)).toBe(false)
  })
})
