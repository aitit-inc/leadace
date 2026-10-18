import { describe, it, expect } from 'vitest'
import { applyOnFor, freshVariantIds, loosening, sameReach, stillApplies } from './proposal'

const current = { outboundChannels: ['email' as const], targetCountries: ['JP'] }

describe('loosening', () => {
  it('adds a channel or a country, keeping what it was written against', () => {
    expect(loosening(current, { outboundChannels: ['form', 'email'], targetCountries: null })).toEqual({
      outboundChannels: { from: ['email'], to: ['email', 'form'] },
    })
    expect(loosening(current, { outboundChannels: null, targetCountries: ['US', 'JP'] })).toEqual({
      targetCountries: { from: ['JP'], to: ['JP', 'US'] },
    })
  })

  it('lifts the country limit', () => {
    expect(loosening(current, { outboundChannels: null, targetCountries: [] })).toEqual({ targetCountries: { from: ['JP'], to: [] } })
  })

  it('refuses a change that drops something the person allowed', () => {
    expect(loosening(current, { outboundChannels: ['form'], targetCountries: null })).toBeNull()
    expect(loosening(current, { outboundChannels: null, targetCountries: ['US'] })).toBeNull()
    expect(loosening(current, { outboundChannels: ['email', 'form'], targetCountries: ['US'] })).toBeNull()
  })

  it('never lifts a pause and never narrows an open country limit', () => {
    expect(loosening({ ...current, outboundChannels: [] }, { outboundChannels: ['email'], targetCountries: null })).toBeNull()
    expect(loosening({ ...current, targetCountries: [] }, { outboundChannels: null, targetCountries: ['JP', 'US'] })).toBeNull()
  })

  it('is null when it changes nothing', () => {
    expect(loosening(current, { outboundChannels: ['email'], targetCountries: ['JP'] })).toBeNull()
    expect(loosening(current, { outboundChannels: null, targetCountries: null })).toBeNull()
  })
})

describe('stillApplies', () => {
  const change = loosening(current, { outboundChannels: ['email', 'form'], targetCountries: null })!

  it('holds while the setting is as it was written against', () => {
    expect(stillApplies(change, current)).toBe(true)
    expect(stillApplies(change, { ...current, targetCountries: ['JP', 'US'] })).toBe(true)
  })

  it('fails once someone changed that setting', () => {
    expect(stillApplies(change, { ...current, outboundChannels: ['email', 'sns_linkedin'] })).toBe(false)
    expect(stillApplies(change, { ...current, outboundChannels: ['email', 'form'] })).toBe(false)
  })
})

describe('sameReach', () => {
  const reach = { outboundChannels: ['form' as const, 'email' as const], targetCountries: ['JP'], targetLanguage: 'ja' as const }

  it('compares every field, lists as sets', () => {
    expect(sameReach(reach, { ...reach, outboundChannels: ['email', 'form'] })).toBe(true)
    expect(sameReach(reach, { ...reach, targetCountries: ['US'] })).toBe(false)
    expect(sameReach(reach, { ...reach, targetLanguage: 'en' })).toBe(false)
  })
})

describe('freshVariantIds', () => {
  it('numbers the day\'s ids past the ones taken', () => {
    expect(freshVariantIds(new Set(['frame_20261019_1', 'frame_20261019_3']), '2026-10-19', 3))
      .toEqual(['frame_20261019_2', 'frame_20261019_4', 'frame_20261019_5'])
  })
})

describe('applyOnFor', () => {
  it('is the next UTC day, across a month end', () => {
    expect(applyOnFor('2026-10-19')).toBe('2026-10-20')
    expect(applyOnFor('2026-10-31')).toBe('2026-11-01')
  })
})
