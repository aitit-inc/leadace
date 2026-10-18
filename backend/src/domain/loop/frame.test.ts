import { describe, it, expect } from 'vitest'
import { seededRng } from './bandit'
import { assessVitals, frameSignal, type FutilityParams } from './frame'

const PARAMS: FutilityParams = {
  futilitySurvivalRate: 0.01,
  futilityConfidence: 0.95,
  futilityMinSends: 100,
}

describe('assessVitals', () => {
  it('reports insufficient below the minimum send floor, even at zero engagement', () => {
    const v = assessVitals({ sends: 99, engaged: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('insufficient')
    expect(v.sends).toBe(99)
    expect(v.engaged).toBe(0)
  })

  it('reports insufficient at zero sends with a flat posterior', () => {
    const v = assessVitals({ sends: 0, engaged: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('insufficient')
    // Beta(1,1) is uniform → pDead ≈ survivalRate, nowhere near confidence.
    expect(v.pDead).toBeLessThan(0.05)
  })

  it('stays ok at the send floor with zero engagement (posterior mass still above the line)', () => {
    // Beta(1, 101): P(rate < 0.01) = 1 − 0.99^101 ≈ 0.64 < 0.95.
    const v = assessVitals({ sends: 100, engaged: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('ok')
    expect(v.pDead).toBeGreaterThan(0.5)
    expect(v.pDead).toBeLessThan(0.75)
  })

  it('turns futile once zero engagement persists well past the floor', () => {
    // Beta(1, 401): P(rate < 0.01) = 1 − 0.99^401 ≈ 0.982 ≥ 0.95.
    const v = assessVitals({ sends: 400, engaged: 0 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('futile')
    expect(v.pDead).toBeGreaterThan(0.95)
  })

  it('a single reply pulls the same volume back from futile', () => {
    // Beta(2, 400): P(rate < 0.01) ≈ 0.91 < 0.95.
    const v = assessVitals({ sends: 400, engaged: 1 }, PARAMS, seededRng('t'))
    expect(v.verdict).toBe('ok')
  })

  it('is deterministic for a given seed', () => {
    const a = assessVitals({ sends: 400, engaged: 0 }, PARAMS, seededRng('vitals:proj'))
    const b = assessVitals({ sends: 400, engaged: 0 }, PARAMS, seededRng('vitals:proj'))
    expect(a).toEqual(b)
  })

  it('sits within Monte Carlo noise of the confidence gate at 298 zero-reply sends', () => {
    // A date-varying seed flipped this input between futile (0.9503) and ok
    // (0.9498) across days — hence the tick's date-free per-project seed.
    // Asserts the true value (1 − 0.99^299 ≈ 0.9505) really straddles the gate.
    const v = assessVitals({ sends: 298, engaged: 0 }, PARAMS, seededRng('a'))
    expect(v.pDead).toBeGreaterThan(0.94)
    expect(v.pDead).toBeLessThan(0.96)
  })

  it('clamps engaged above sends instead of feeding Beta a non-positive shape', () => {
    const v = assessVitals({ sends: 100, engaged: 150 }, PARAMS, seededRng('t'))
    expect(v.engaged).toBe(100)
    expect(v.verdict).toBe('ok')
    expect(v.pDead).toBe(0)
  })
})

describe('frameSignal', () => {
  const at = (trials: number, positive: number, vitals: 'ok' | 'insufficient' | 'futile' = 'ok') =>
    frameSignal({ trials, positive }, vitals, seededRng('t'))

  it('stays closed until the frame has its trials, even at no positive', () => {
    expect(at(99, 0).open).toBe(false)
  })

  it('opens on a frame with no positive past the trials (Beta(1, 367): P ≈ 0.975)', () => {
    const s = at(366, 0)
    expect(s.pBelow).toBeGreaterThan(0.95)
    expect(s.open).toBe(true)
  })

  it('opens at 0.2% and stays closed at 1.9% or on too little evidence at 0.5%', () => {
    expect(at(2079, 4).open).toBe(true)
    expect(at(624, 12).open).toBe(false)
    expect(at(190, 1).open).toBe(false)
  })

  it('stays closed while vitals are futile', () => {
    expect(at(366, 0, 'futile').open).toBe(false)
    expect(at(366, 0, 'insufficient').open).toBe(true)
  })
})
