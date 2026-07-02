import { describe, it, expect } from 'vitest'
import {
  inferCountryFromDomain,
  isAllowedSendCountry,
  buildCountryCodeReference,
  ALLOWED_SEND_COUNTRIES,
} from './country'

describe('inferCountryFromDomain', () => {
  it('maps a known ccTLD to its country', () => {
    expect(inferCountryFromDomain('example.jp')).toEqual({ country: 'JP', source: 'tld_inferred' })
  })

  it('strips a leading www. and lowercases before inferring', () => {
    expect(inferCountryFromDomain('www.EXAMPLE.DE')).toEqual({ country: 'DE', source: 'tld_inferred' })
  })

  it('maps the uk alias to GB', () => {
    expect(inferCountryFromDomain('example.uk')).toEqual({ country: 'GB', source: 'tld_inferred' })
  })

  it('returns null for generic TLDs (no country signal)', () => {
    expect(inferCountryFromDomain('example.com')).toBeNull()
    expect(inferCountryFromDomain('example.io')).toBeNull()
    expect(inferCountryFromDomain('example.ai')).toBeNull()
  })

  it('returns null for unmapped ccTLDs and dotless input', () => {
    expect(inferCountryFromDomain('example.zz')).toBeNull()
    expect(inferCountryFromDomain('localhost')).toBeNull()
  })
})

describe('isAllowedSendCountry', () => {
  it('warn-allows when the country is unknown', () => {
    expect(isAllowedSendCountry(null)).toEqual({ allowed: true, reason: 'unknown_warn' })
    expect(isAllowedSendCountry(undefined)).toEqual({ allowed: true, reason: 'unknown_warn' })
  })

  it('allows the supported countries, case-insensitively', () => {
    expect(isAllowedSendCountry('US')).toEqual({ allowed: true, reason: 'allowed' })
    expect(isAllowedSendCountry('jp')).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('blocks an unsupported country and echoes the uppercased code', () => {
    expect(isAllowedSendCountry('GB')).toEqual({ allowed: false, reason: 'unsupported_country', country: 'GB' })
    expect(isAllowedSendCountry('fr')).toEqual({ allowed: false, reason: 'unsupported_country', country: 'FR' })
  })
})

describe('buildCountryCodeReference', () => {
  const ref = buildCountryCodeReference()

  it('reports the send-allowed subset verbatim from ALLOWED_SEND_COUNTRIES', () => {
    expect(ref.sendAllowed).toEqual([...ALLOWED_SEND_COUNTRIES])
  })

  it('derives sendAllowed flags from ALLOWED_SEND_COUNTRIES, not a hand-set field', () => {
    for (const entry of ref.countries) {
      expect(entry.sendAllowed).toBe(
        (ALLOWED_SEND_COUNTRIES as readonly string[]).includes(entry.code),
      )
    }
  })

  it('includes every send-allowed country in the catalog, flagged true', () => {
    for (const code of ALLOWED_SEND_COUNTRIES) {
      const entry = ref.countries.find((c) => c.code === code)
      expect(entry).toBeDefined()
      expect(entry?.sendAllowed).toBe(true)
    }
  })

  it('holds well-formed, unique ISO 3166-1 alpha-2 codes with non-empty names', () => {
    const seen = new Set<string>()
    for (const entry of ref.countries) {
      expect(entry.code).toMatch(/^[A-Z]{2}$/)
      expect(entry.name.trim().length).toBeGreaterThan(0)
      expect(seen.has(entry.code)).toBe(false)
      seen.add(entry.code)
    }
  })
})
