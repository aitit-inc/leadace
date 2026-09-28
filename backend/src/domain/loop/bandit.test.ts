import { describe, it, expect } from 'vitest'
import { seededRng, weightedDraw, wilsonBounds } from './bandit'

describe('wilsonBounds', () => {
  it('n=0 → maximal ignorance {0,1}', () => {
    expect(wilsonBounds(0, 0)).toEqual({ lower: 0, upper: 1 })
  })
  it('zero successes → lower exactly 0', () => {
    const { lower, upper } = wilsonBounds(0, 30)
    expect(lower).toBe(0)
    expect(upper).toBeGreaterThan(0)
  })
  it('all successes → upper exactly 1', () => {
    const { lower, upper } = wilsonBounds(30, 30)
    expect(upper).toBe(1)
    expect(lower).toBeLessThan(1)
  })
  it('bounds always ordered and within [0,1]', () => {
    for (const [s, n] of [[1, 1], [3, 10], [50, 100], [1, 50], [499, 1000]] as const) {
      const { lower, upper } = wilsonBounds(s, n)
      expect(lower).toBeLessThanOrEqual(upper)
      expect(lower).toBeGreaterThanOrEqual(0)
      expect(upper).toBeLessThanOrEqual(1)
      expect(lower).toBeLessThanOrEqual(s / n)
      expect(upper).toBeGreaterThanOrEqual(s / n)
    }
  })
  it('throws on invalid input', () => {
    expect(() => wilsonBounds(5, 3)).toThrow()
    expect(() => wilsonBounds(-1, 10)).toThrow()
  })
})

describe('seededRng', () => {
  it('same seed → identical sequence', () => {
    const a = seededRng('2026-07-14:proj1')
    const b = seededRng('2026-07-14:proj1')
    for (let i = 0; i < 100; i++) expect(a()).toBe(b())
  })
  it('different seeds → different sequences', () => {
    const a = seededRng('2026-07-14:proj1')
    const b = seededRng('2026-07-15:proj1')
    const va = Array.from({ length: 10 }, () => a())
    const vb = Array.from({ length: 10 }, () => b())
    expect(va).not.toEqual(vb)
  })
  it('values stay in [0, 1)', () => {
    const rng = seededRng('range-check')
    for (let i = 0; i < 1000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('weightedDraw', () => {
  it('rng=0 → first positive-weight arm', () => {
    expect(weightedDraw({ a: 0.3, b: 0.7 }, () => 0)).toBe('a')
  })
  it('rng→1 → last arm (float-sum fall-through)', () => {
    expect(weightedDraw({ a: 0.3, b: 0.7 }, () => 0.9999999)).toBe('b')
  })
  it('cumulative boundary picks the upper side', () => {
    expect(weightedDraw({ a: 0.5, b: 0.5 }, () => 0.5)).toBe('b')
  })
  it('single arm always returned', () => {
    expect(weightedDraw({ a: 1 }, () => 0.42)).toBe('a')
  })
  it('zero-weight arm is unreachable', () => {
    expect(weightedDraw({ a: 0, b: 1 }, () => 0)).toBe('b')
  })
  it('empty distribution throws', () => {
    expect(() => weightedDraw({}, () => 0)).toThrow()
  })
  it('empirical frequencies track the weights', () => {
    const rng = seededRng('draw-frequency')
    const counts: Record<string, number> = { a: 0, b: 0 }
    const N = 20000
    for (let i = 0; i < N; i++) counts[weightedDraw({ a: 0.25, b: 0.75 }, rng)]!++
    expect(counts['a']! / N).toBeGreaterThan(0.22)
    expect(counts['a']! / N).toBeLessThan(0.28)
  })
})
