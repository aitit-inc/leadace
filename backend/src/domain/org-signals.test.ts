import { describe, it, expect } from 'vitest'
import {
  parseOrgSignals,
  parseOrgSignalsText,
  isEmptySignals,
  HIGHLIGHT_MAX_LENGTH,
  HIGHLIGHTS_MAX_COUNT,
} from './org-signals'

describe('parseOrgSignalsText', () => {
  it('parses a JSON object payload', () => {
    expect(parseOrgSignalsText('{"highlights":["Raised Series B on 2026-05-01"]}')).toEqual({
      highlights: ['Raised Series B on 2026-05-01'],
    })
  })

  it('returns null for prose, JSON arrays, JSON scalars, and truncated JSON', () => {
    expect(parseOrgSignalsText('Sorry, I could not find anything.')).toBeNull()
    expect(parseOrgSignalsText('[1, 2]')).toBeNull()
    expect(parseOrgSignalsText('"just a string"')).toBeNull()
    expect(parseOrgSignalsText('{"highlights":["Raised Series B on 2026-')).toBeNull()
  })
})

describe('parseOrgSignals', () => {
  it('keeps a fully valid payload intact', () => {
    const input = {
      pressReleases: [{ title: 'Launch', url: 'https://x.test/p', publishedAt: '2026-06-01' }],
      funding: { round: 'Series B', amount: '$30M', investors: ['Acme VC'], announcedAt: '2026-05-20' },
      hiring: { totalOpen: 12, departments: ['Sales'], sampleTitles: ['AE'], sourceUrl: 'https://x.test/jobs' },
      leadership: [{ name: 'Jane Doe', role: 'CTO', sourceUrl: 'https://x.test/news' }],
      highlights: ['Opened Tokyo office on 2026-06-02'],
    }
    expect(parseOrgSignals(input)).toEqual(input)
  })

  it('drops a non-conforming array entry but keeps valid siblings', () => {
    const parsed = parseOrgSignals({
      pressReleases: [{ title: '' }, { title: 'Valid', publishedAt: '2026-06-01' }, 'garbage'],
      leadership: [{ role: 'CEO' }, { name: 'Kept' }],
      funding: { investors: ['Acme VC', '', 42] },
    })
    expect(parsed?.pressReleases).toEqual([{ title: 'Valid', publishedAt: '2026-06-01' }])
    expect(parsed?.leadership).toEqual([{ name: 'Kept' }])
    expect(parsed?.funding).toEqual({ investors: ['Acme VC'] })
  })

  it('drops non-ISO dates at field level, keeping the entry', () => {
    const parsed = parseOrgSignals({
      pressReleases: [{ title: 'Kept', publishedAt: 'May 2026' }],
      funding: { round: 'Seed', announcedAt: 'last month' },
    })
    expect(parsed?.pressReleases).toEqual([{ title: 'Kept' }])
    expect(parsed?.funding).toEqual({ round: 'Seed' })
  })

  it('drops a sub-object whose every field is invalid or absent', () => {
    const parsed = parseOrgSignals({ funding: {}, hiring: { totalOpen: -3 } })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('makes every payload string well-formed (lone surrogates never reach jsonb)', () => {
    const lone = String.fromCharCode(0xd800)
    const parsed = parseOrgSignals({
      pressReleases: [{ title: `Acme${lone} expands` }],
      highlights: [`Raised $5M${lone} on 2026-06-01`],
    })
    expect(parsed?.pressReleases?.[0]?.title.isWellFormed()).toBe(true)
    expect(parsed?.highlights?.[0]?.isWellFormed()).toBe(true)
  })

  it('treats empty strings, empty arrays, and zero counts as absent', () => {
    const parsed = parseOrgSignals({
      funding: { round: '', investors: [] },
      hiring: { totalOpen: 0, departments: [''] },
    })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('sanitizes highlights: strips citation markers, trims, caps length and count', () => {
    const long = 'x'.repeat(HIGHLIGHT_MAX_LENGTH + 50)
    const parsed = parseOrgSignals({
      highlights: [
        'Raised $30M [1] on 2026-05-20 [2, 3] [1.5.2]',
        long,
        42,
        '   ',
        'a', 'b', 'c', 'd', 'e',
      ],
    })
    expect(parsed?.highlights?.[0]).toBe('Raised $30M on 2026-05-20')
    expect(parsed?.highlights?.[1]).toHaveLength(HIGHLIGHT_MAX_LENGTH)
    expect(parsed?.highlights).toHaveLength(HIGHLIGHTS_MAX_COUNT)
  })
})
