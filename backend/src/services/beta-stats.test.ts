import { describe, expect, it } from 'vitest'
import { foundRateDropped } from './beta-stats'

const week = { judged: 700, fit: 420, reachable: 280 } // 60% · 40%

describe('foundRateDropped', () => {
  it('flags a fit share below half of the prior week', () => {
    expect(foundRateDropped({ judged: 100, fit: 29, reachable: 25 }, week)).toBe(true)
  })

  it('flags a reachable share below half of the prior week', () => {
    expect(foundRateDropped({ judged: 100, fit: 60, reachable: 19 }, week)).toBe(true)
  })

  it('does not flag a share at exactly half', () => {
    expect(foundRateDropped({ judged: 100, fit: 30, reachable: 20 }, week)).toBe(false)
  })

  it('stays quiet on a day with too few judged to read', () => {
    expect(foundRateDropped({ judged: 29, fit: 0, reachable: 0 }, week)).toBe(false)
    expect(foundRateDropped({ judged: 100, fit: 0, reachable: 0 }, { judged: 29, fit: 29, reachable: 29 })).toBe(false)
  })
})
