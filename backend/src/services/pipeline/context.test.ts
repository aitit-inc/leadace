import { describe, expect, it } from 'vitest'
import { apexDomainOf, parseIndustryVocabulary } from './context'

describe('apexDomainOf', () => {
  it('strips www and paths, rejects garbage', () => {
    expect(apexDomainOf('https://www.Example.com/about')).toBe('example.com')
    expect(apexDomainOf('https://sub.example.co.jp')).toBe('sub.example.co.jp')
    expect(apexDomainOf('not a url')).toBeNull()
  })
})

describe('parseIndustryVocabulary', () => {
  it('reads only backticked list items', () => {
    const md = '# Industry\n\n### Software\n- `B2B SaaS`\n- `AI / ML`\n\nOther text `not an item`\n- plain bullet\n'
    expect(parseIndustryVocabulary(md)).toEqual(['B2B SaaS', 'AI / ML'])
  })
})
