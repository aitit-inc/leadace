import { describe, expect, it } from 'vitest'
import { citedCompetitors } from './strategy-draft'

const candidate = (name: string, url: string) => ({ name, url, why: 'Same buyers' })

describe('citedCompetitors', () => {
  const citations = [{ passage: 'Acme sells scheduling', pages: ['https://www.acme.example/pricing', 'https://review.example/acme', 'https://self.example/'] }]
  const own = 'https://www.self.example'

  it('keeps a candidate whose site the search cited, www or not', () => {
    expect(citedCompetitors([candidate('Acme', 'https://acme.example')], citations, own)).toHaveLength(1)
  })

  it('drops a candidate the search never cited, one without a readable URL, and the company itself', () => {
    expect(citedCompetitors([candidate('Ghost', 'https://ghost.example'), candidate('Blank', ''), candidate('Self', 'https://self.example')], citations, own)).toEqual([])
  })
})
