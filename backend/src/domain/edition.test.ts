import { describe, it, expect } from 'vitest'
import { parseEdition } from './edition'

describe('parseEdition', () => {
  it('accepts the two valid editions', () => {
    expect(parseEdition('cloud')).toBe('cloud')
    expect(parseEdition('self-hosted')).toBe('self-hosted')
  })

  it('fails closed to self-hosted on anything invalid', () => {
    // A self-host wrongly flipped to 'cloud' would silently expose Stripe,
    // so the default must never be 'cloud'.
    expect(parseEdition(undefined)).toBe('self-hosted')
    expect(parseEdition(null)).toBe('self-hosted')
    expect(parseEdition('')).toBe('self-hosted')
    expect(parseEdition('Cloud')).toBe('self-hosted')
    expect(parseEdition('bogus')).toBe('self-hosted')
  })
})
