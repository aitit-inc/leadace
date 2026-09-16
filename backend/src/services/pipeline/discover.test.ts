import { describe, expect, it } from 'vitest'
import { passageUrls } from './discover'

const citation = (pages: string[]) => ({ passage: 'p', pages })

describe('passageUrls', () => {
  it('keeps one entry per page across repeated citations', () => {
    const citations = [citation(['https://a.example/x']), citation(['https://a.example/x', 'https://b.example'])]
    expect(passageUrls([1, 2], citations)).toEqual(['https://a.example/x', 'https://b.example'])
  })

  it('drops passage numbers with no citation and non-http pages', () => {
    const citations = [citation(['ftp://a.example', 'https://b.example'])]
    expect(passageUrls([1, 7], citations)).toEqual(['https://b.example'])
  })

  it('caps at the source limit so one claim cannot fan out', () => {
    const citations = [citation(['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'])]
    expect(passageUrls([1], citations)).toHaveLength(3)
  })
})
