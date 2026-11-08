import { describe, expect, it } from 'vitest'
import { shapeCandidates, type MapRows } from './discover'

const rows: MapRows = { active: [{ slug: 'regional-lists', approach: 'a' }, { slug: 'job-posts', approach: 'b' }], closed: [], pinned: null }
const reported = {
  name: 'Acme',
  organizationName: '',
  websiteUrl: 'https://acme.example',
  overview: 'Makes things.',
  industry: 'SaaS',
  country: 'US',
  employeeBand: null,
  matchReason: 'Listed as a call center.',
  priority: 2,
  sourceUrls: ['https://list.example/a', 'https://list.example/a', 'not a url'],
  signals: [{ text: '2026-11-01: hiring', sourceUrls: ['https://acme.example/jobs'] }, { text: '2026-10-01: funding', sourceUrls: [] }],
  row: 'regional-lists',
}

describe('shapeCandidates', () => {
  it('holds a reported candidate to the candidate shape', () => {
    const [c] = shapeCandidates([reported], rows, ['SaaS'])
    expect(c).toMatchObject({
      organizationName: 'Acme',
      industry: 'SaaS',
      country: 'US',
      matchSourceUrls: ['https://list.example/a'],
      discoveryStrategy: 'regional-lists',
      signals: [{ text: '2026-11-01: hiring', sourceUrls: ['https://acme.example/jobs'] }],
    })
    expect(c).not.toHaveProperty('employeeBand')
  })
  it('tags only an active row, or the pinned one', () => {
    const base = { ...reported, sourceUrls: [], signals: [] }
    expect(shapeCandidates([{ ...base, row: 'closed-row' }], rows, [])[0]).not.toHaveProperty('discoveryStrategy')
    expect(shapeCandidates([{ ...base, row: null }], { ...rows, pinned: 'job-posts' }, [])[0]?.discoveryStrategy).toBe('job-posts')
  })
  it('drops a candidate it cannot hold and clamps the rest', () => {
    const base = { ...reported, sourceUrls: [], signals: [] }
    expect(shapeCandidates([{ ...base, websiteUrl: 'acme' }, { ...base, name: ' ' }], rows, [])).toEqual([])
    expect(shapeCandidates([{ ...base, priority: 9, industry: 'Unknown', country: 'usa' }], rows, ['SaaS'])[0]).toMatchObject({ priority: 5, industry: 'Other' })
  })
})
