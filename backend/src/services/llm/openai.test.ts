import { describe, expect, it } from 'vitest'
import { citationsOf, searchedPagesOf, withoutOpenAITag } from './openai'

const cite = (url: string, start: number, end: number) => ({ type: 'url_citation' as const, url, title: '', start_index: start, end_index: end })

describe('citationsOf', () => {
  it('slices each passage from its own part and merges the pages of a repeated passage', () => {
    const marker = '[acme.example](x)'
    const first = 'Acme raised a seed round (' + marker + ').'
    const second = marker + ' again'
    const parts = [
      { text: first, annotations: [cite('https://acme.example/news', first.indexOf(marker), first.indexOf(marker) + marker.length)] },
      { text: second, annotations: [cite('https://acme.example/about', 0, marker.length)] },
    ]
    expect(citationsOf(parts)).toEqual([{ passage: marker, pages: ['https://acme.example/news', 'https://acme.example/about'] }])
  })

  it('drops the openai tag so one page reads as one', () => {
    const parts = [{ text: 'see [a]', annotations: [cite('https://a.example/p?utm_source=openai', 4, 7), cite('https://a.example/p', 4, 7)] }]
    expect(citationsOf(parts)).toEqual([{ passage: '[a]', pages: ['https://a.example/p'] }])
  })

  it('leaves out annotations that are not url citations or cover no text', () => {
    const parts = [{ text: 'x  y', annotations: [{ type: 'file_citation' as const, file_id: 'f', filename: 'a.pdf', index: 0 }, cite('https://b.example', 1, 3)] }]
    expect(citationsOf(parts)).toEqual([])
  })
})

describe('withoutOpenAITag', () => {
  it('keeps other query parameters', () => {
    expect(withoutOpenAITag('https://a.example/p?id=3&utm_source=openai')).toBe('https://a.example/p?id=3')
  })

  it('leaves a url with another utm source, or an unparsable one, as it is', () => {
    expect(withoutOpenAITag('https://a.example/?utm_source=x')).toBe('https://a.example/?utm_source=x')
    expect(withoutOpenAITag('not a url')).toBe('not a url')
  })
})

describe('searchedPagesOf', () => {
  it('keeps opened and cited pages on the given domains only, never mere search results or failed opens', () => {
    const response = {
      output: [
        { type: 'web_search_call', action: { type: 'search', query: 'q', sources: [{ type: 'url', url: 'https://www.acme.jp/a?utm_source=openai' }, { type: 'url', url: 'https://other.example/b' }] } },
        { type: 'web_search_call', status: 'completed', action: { type: 'open_page', url: 'https://shop.acme.jp/c' } },
        { type: 'web_search_call', status: 'failed', action: { type: 'open_page', url: 'https://acme.jp/failed' } },
        { type: 'message', content: [{ type: 'output_text', text: 't', annotations: [cite('https://acme.jp/d', 0, 1), cite('https://notacme.jp/e', 0, 1)] }] },
      ],
    } as unknown as Parameters<typeof searchedPagesOf>[0]
    expect(searchedPagesOf(response, ['acme.jp'])).toEqual(['https://shop.acme.jp/c', 'https://acme.jp/d'])
  })
})
