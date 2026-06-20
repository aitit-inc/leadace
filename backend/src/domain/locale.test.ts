import { describe, expect, it } from 'vitest'
import { localeForCountry } from './locale'

describe('localeForCountry', () => {
  it('maps JP to Japanese, case-insensitively', () => {
    expect(localeForCountry('JP')).toBe('ja')
    expect(localeForCountry('jp')).toBe('ja')
  })

  it('maps every other country, null, and undefined to English', () => {
    expect(localeForCountry('US')).toBe('en')
    expect(localeForCountry('CA')).toBe('en')
    expect(localeForCountry(null)).toBe('en')
    expect(localeForCountry(undefined)).toBe('en')
  })
})
