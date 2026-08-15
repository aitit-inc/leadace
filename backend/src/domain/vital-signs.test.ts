import { describe, it, expect } from 'vitest'
import { seededRng } from './arm-bandit'
import { assessVitals, type FutilityParams } from './vital-signs'

const PARAMS: FutilityParams = {
  futilitySurvivalRate: 0.01,
  futilityConfidence: 0.95,
  futilityMinSends: 100,
}

describe('assessVitals', () => {
  it('reports insufficient below the minimum send floor, even at zero replies', () => {
    const v = assessVitals({ sends: 99, replies: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('insufficient')
    expect(v.sends).toBe(99)
    expect(v.replies).toBe(0)
  })

  it('reports insufficient at zero sends with a flat posterior', () => {
    const v = assessVitals({ sends: 0, replies: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('insufficient')
    // Beta(1,1) is uniform → pDead ≈ survivalRate, nowhere near confidence.
    expect(v.pDead).toBeLessThan(0.05)
  })

  it('stays ok at the send floor with zero replies (posterior mass still above the line)', () => {
    // Beta(1, 101): P(rate < 0.01) = 1 − 0.99^101 ≈ 0.64 < 0.95.
    const v = assessVitals({ sends: 100, replies: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('ok')
    expect(v.pDead).toBeGreaterThan(0.5)
    expect(v.pDead).toBeLessThan(0.75)
  })

  it('turns futile once zero replies persist well past the floor', () => {
    // Beta(1, 401): P(rate < 0.01) = 1 − 0.99^401 ≈ 0.982 ≥ 0.95.
    const v = assessVitals({ sends: 400, replies: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('futile')
    expect(v.pDead).toBeGreaterThan(0.95)
  })

  it('a single reply pulls the same volume back from futile', () => {
    // Beta(2, 400): P(rate < 0.01) ≈ 0.91 < 0.95.
    const v = assessVitals({ sends: 400, replies: 1 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('ok')
  })

  it('is deterministic for a given seed', () => {
    const a = assessVitals({ sends: 400, replies: 0 }, PARAMS, seededRng('vitals:proj'))
    const b = assessVitals({ sends: 400, replies: 0 }, PARAMS, seededRng('vitals:proj'))
    expect(a).toEqual(b)
  })

  it('sits within Monte Carlo noise of the confidence gate at 298 zero-reply sends', () => {
    // A date-varying seed flipped this input between futile (0.9503) and ok
    // (0.9498) across days — hence the tick's date-free per-project seed.
    // Asserts the true value (1 − 0.99^299 ≈ 0.9505) really straddles the gate.
    const v = assessVitals({ sends: 298, replies: 0 }, PARAMS, seededRng('a'))
    expect(v.pDead).toBeGreaterThan(0.94)
    expect(v.pDead).toBeLessThan(0.96)
  })

  it('clamps replies above sends instead of feeding Beta a non-positive shape', () => {
    const v = assessVitals({ sends: 100, replies: 150 }, PARAMS, seededRng('t'))
    expect(v.replies).toBe(100)
    expect(v.verdict).toBe('ok')
    expect(v.pDead).toBe(0)
  })
})
