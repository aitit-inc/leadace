import { describe, expect, it } from 'vitest'
import { datedEvents, inRetrieved, newestFirst, parseStored } from './enrich'

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

describe('datedEvents', () => {
  const now = new Date('2026-09-12T00:00:00Z')
  const page = 'https://www.example.com/news/2026'
  const retrieved = [page]
  it('keeps a dated event read from a retrieved page, tagged with its source apex', () => {
    expect(datedEvents([{ text: '2026-08-30: Example opened a Berlin office.', foundOnUrl: 'https://www.example.com/news/2026' }], retrieved, now))
      .toEqual(['2026-08-30: Example opened a Berlin office. (example.com)'])
  })
  it('drops an event whose page was not retrieved', () => {
    expect(datedEvents([{ text: '2026-08-30: Example opened a Berlin office.', foundOnUrl: 'https://www.example.com/about' }], retrieved, now)).toEqual([])
  })
  it('drops an event outside the signal window or without a leading date', () => {
    expect(datedEvents([
      { text: '2026-05-01: Example raised a seed round.', foundOnUrl: page },
      { text: 'Example raised a seed round.', foundOnUrl: page },
      { text: '2026-10-01: Example will exhibit at a trade fair.', foundOnUrl: page },
    ], retrieved, now)).toEqual([])
  })
})

describe('newestFirst', () => {
  it('orders by the leading date, newest first, and drops exact duplicates', () => {
    expect(newestFirst(['2026-07-24: b', '2026-09-01: a', '2026-08-27: c', '2026-09-01: a'])).toEqual(['2026-09-01: a', '2026-08-27: c', '2026-07-24: b'])
  })
})

describe('parseStored', () => {
  const candidate = {
    name: 'Acme', organizationName: 'Acme Inc', websiteUrl: 'https://acme.example',
    overview: 'Builds things', industry: 'Other', matchReason: 'Ships an MCP server',
    priority: 1 as const, signals: [],
  }

  it('applies a default for a field the stored shape predates', () => {
    const { candidates, stale } = parseStored([candidate as never])
    expect(stale).toEqual([])
    expect(candidates[0]?.matchSourceUrls).toEqual([])
  })

  it('drops a shape too old to parse without failing the batch', () => {
    const legacy = { ...candidate, name: 'Old', signals: ['2026-03-12: Series B (TechCrunch)'] }
    const { candidates, stale } = parseStored([legacy as never, candidate as never])
    expect(stale).toEqual(['Old'])
    expect(candidates).toHaveLength(1)
  })
})
