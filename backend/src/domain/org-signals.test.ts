import { describe, it, expect } from 'vitest'
import {
  parseOrgSignals,
  parseOrgSignalsText,
  isEmptySignals,
  HIGHLIGHT_MAX_LENGTH,
  HIGHLIGHTS_MAX_COUNT,
} from './org-signals'

const NOW = new Date('2026-07-25T00:00:00Z')
const parse = (raw: unknown) => parseOrgSignals(raw, NOW)
const parseText = (text: string) => parseOrgSignalsText(text, NOW)

describe('parseOrgSignalsText', () => {
  it('parses a JSON object payload', () => {
    expect(parseText('{"highlights":["Raised Series B on 2026-06-05"]}')).toEqual({
      highlights: ['Raised Series B on 2026-06-05'],
    })
  })

  it('returns null for prose, JSON arrays, JSON scalars, and truncated JSON', () => {
    expect(parseText('Sorry, I could not find anything.')).toBeNull()
    expect(parseText('[1, 2]')).toBeNull()
    expect(parseText('"just a string"')).toBeNull()
    expect(parseText('{"highlights":["Raised Series B on 2026-')).toBeNull()
  })
})

describe('parseOrgSignals', () => {
  it('keeps a fully valid payload intact', () => {
    const input = {
      pressReleases: [{ title: 'Launch', url: 'https://x.test/p', publishedAt: '2026-06-01' }],
      funding: { round: 'Series B', amount: '$30M', investors: ['Acme VC'], announcedAt: '2026-06-20' },
      hiring: { totalOpen: 12, departments: ['Sales'], sampleTitles: ['AE'], sourceUrl: 'https://x.test/jobs' },
      leadership: [{ name: 'Jane Doe', role: 'CTO', sourceUrl: 'https://x.test/news' }],
      highlights: ['Opened Tokyo office on 2026-06-02'],
    }
    expect(parse(input)).toEqual(input)
  })

  it('drops a non-conforming array entry but keeps valid siblings', () => {
    const parsed = parse({
      pressReleases: [{ title: '' }, { title: 'Valid', publishedAt: '2026-06-01' }, 'garbage'],
      leadership: [{ role: 'CEO' }, { name: 'Kept' }],
      funding: { investors: ['Acme VC', '', 42], announcedAt: '2026-06-01' },
    })
    expect(parsed?.pressReleases).toEqual([{ title: 'Valid', publishedAt: '2026-06-01' }])
    expect(parsed?.leadership).toEqual([{ name: 'Kept' }])
    expect(parsed?.funding).toEqual({ investors: ['Acme VC'], announcedAt: '2026-06-01' })
  })

  it('drops an event entry whose date is not an absolute ISO date', () => {
    const parsed = parse({
      pressReleases: [{ title: 'Dropped', publishedAt: 'May 2026' }],
      funding: { round: 'Seed', announcedAt: 'last month' },
    })
    expect(parsed).toEqual({})
  })

  it('keeps undated hiring and leadership, which describe state rather than events', () => {
    const parsed = parse({
      hiring: { totalOpen: 12, departments: ['Sales'] },
      leadership: [{ name: 'Jane Doe', role: 'CTO' }],
    })
    expect(parsed).toEqual({
      hiring: { totalOpen: 12, departments: ['Sales'] },
      leadership: [{ name: 'Jane Doe', role: 'CTO' }],
    })
  })

  it('drops a sub-object whose every field is invalid or absent', () => {
    const parsed = parse({ funding: {}, hiring: { totalOpen: -3 } })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('makes every payload string well-formed (lone surrogates never reach jsonb)', () => {
    const lone = String.fromCharCode(0xd800)
    const parsed = parse({
      pressReleases: [{ title: `Acme${lone} expands`, publishedAt: '2026-06-01' }],
      highlights: [`Raised $5M${lone} on 2026-06-01`],
    })
    expect(parsed?.pressReleases?.[0]?.title.isWellFormed()).toBe(true)
    expect(parsed?.highlights?.[0]?.isWellFormed()).toBe(true)
  })

  it('treats empty strings, empty arrays, and zero counts as absent', () => {
    const parsed = parse({
      funding: { round: '', investors: [] },
      hiring: { totalOpen: 0, departments: [''] },
    })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('sanitizes highlights: strips citation markers, trims, caps length and count', () => {
    const long = `on 2026-06-20 ${'x'.repeat(HIGHLIGHT_MAX_LENGTH)}`
    const parsed = parse({
      highlights: [
        'Raised $30M [1] on 2026-06-20 [2, 3] [1.5.2]',
        long,
        42,
        '   ',
        'a on 2026-06-05', 'b on 2026-06-06', 'c on 2026-06-07', 'd on 2026-06-08', 'e on 2026-06-09',
      ],
    })
    expect(parsed?.highlights?.[0]).toBe('Raised $30M on 2026-06-20')
    expect(parsed?.highlights?.[1]).toHaveLength(HIGHLIGHT_MAX_LENGTH)
    expect(parsed?.highlights).toHaveLength(HIGHLIGHTS_MAX_COUNT)
  })

  it('drops a highlight whose date falls past the length cap', () => {
    const parsed = parse({ highlights: [`${'x'.repeat(HIGHLIGHT_MAX_LENGTH)} on 2026-06-20`] })
    expect(parsed).toEqual({})
  })

  it('drops highlights carrying no absolute date', () => {
    const parsed = parse({
      highlights: [
        'Acme provides an AI-powered helpdesk platform for equipment dealers.',
        'Shipped v2 last week',
        'Opened a Tokyo office on 2026-06-02',
      ],
    })
    expect(parsed).toEqual({ highlights: ['Opened a Tokyo office on 2026-06-02'] })
  })

  it('yields {} when every highlight is undated', () => {
    const parsed = parse({ highlights: ['A great company', 'Growing fast'] })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('drops highlights dated before the window or in the future', () => {
    const parsed = parse({
      highlights: [
        'Raised Series A on 2025-07-02',
        'Won an award on 2026-04-01',
        'Will open an office on 2027-01-01',
        'Launched v3 on 2026-07-15',
      ],
    })
    expect(parsed).toEqual({ highlights: ['Launched v3 on 2026-07-15'] })
  })

  it('accepts a highlight whose event date trails an older one', () => {
    expect(parse({ highlights: ['Founded in 2010, raised a Series B on 2026-07-20'] })).toEqual({
      highlights: ['Founded in 2010, raised a Series B on 2026-07-20'],
    })
  })

  it('drops an undated press release and an undated funding round', () => {
    const parsed = parse({
      pressReleases: [{ title: 'We are a great company' }],
      funding: { round: 'Series B' },
    })
    expect(parsed).toEqual({})
    expect(parsed && isEmptySignals(parsed)).toBe(true)
  })

  it('drops a dated press release outside the window, keeping an in-window one', () => {
    const parsed = parse({
      pressReleases: [
        { title: 'Ancient', publishedAt: '2019-03-01' },
        { title: 'Recent', publishedAt: '2026-07-01' },
      ],
    })
    expect(parsed?.pressReleases).toEqual([{ title: 'Recent', publishedAt: '2026-07-01' }])
  })
})
