import { describe, it, expect } from 'vitest'
import { coarseIndustry, COARSE_INDUSTRIES, type CoarseIndustry } from './coarse-industry'

describe('coarseIndustry', () => {
  it('maps a representative fine label from each section to its bucket', () => {
    const cases: Array<[string, CoarseIndustry]> = [
      ['B2B SaaS', 'software_tech'],
      ['AI / ML', 'software_tech'],
      ['FinTech', 'vertical_tech'],
      ['RetailTech / E-commerce Tech', 'vertical_tech'],
      ['Manufacturing', 'hardware_industrial'],
      ['Agriculture', 'hardware_industrial'],
      ['E-commerce / Retail', 'commerce_consumer'],
      ['Travel / Hospitality', 'commerce_consumer'],
      ['Financial Services', 'services'],
      ['Marketing / Advertising Agency', 'services'],
      ['Government / Public Sector', 'public_nonprofit'],
      ['Industry Association / Federation', 'public_nonprofit'],
      ['Other', 'other'],
    ]
    for (const [fine, coarse] of cases) expect(coarseIndustry(fine)).toBe(coarse)
  })

  it('distinguishes the tech-vs-vertical and vendor-vs-operator splits', () => {
    expect(coarseIndustry('B2B SaaS')).toBe('software_tech')
    expect(coarseIndustry('HealthTech / Biotech')).toBe('vertical_tech')
    expect(coarseIndustry('Healthcare Provider')).toBe('services')
    expect(coarseIndustry('PropTech / Real Estate Tech')).toBe('vertical_tech')
    expect(coarseIndustry('Real Estate Services')).toBe('services')
  })

  it('collapses null / undefined / empty / free-form to other', () => {
    expect(coarseIndustry(null)).toBe('other')
    expect(coarseIndustry(undefined)).toBe('other')
    expect(coarseIndustry('')).toBe('other')
    expect(coarseIndustry('   ')).toBe('other')
    expect(coarseIndustry('Underwater Basket Weaving')).toBe('other')
  })

  it('trims surrounding whitespace before matching', () => {
    expect(coarseIndustry('  FinTech  ')).toBe('vertical_tech')
  })

  it('is case-sensitive on the controlled vocabulary (no silent fuzzy match)', () => {
    expect(coarseIndustry('fintech')).toBe('other')
  })

  it('only ever returns one of the 7 declared buckets', () => {
    const set = new Set<string>(COARSE_INDUSTRIES)
    for (const fine of ['B2B SaaS', 'Other', 'nonsense', '']) {
      expect(set.has(coarseIndustry(fine))).toBe(true)
    }
  })
})
