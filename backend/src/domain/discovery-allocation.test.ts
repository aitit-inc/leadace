import { describe, expect, it } from 'vitest'
import { seededRng } from './arm-bandit'
import { apportionLargestRemainder, drawExploreSlots } from './discovery-allocation'

describe('apportionLargestRemainder', () => {
  it('splits exactly proportional weights without remainders', () => {
    expect(apportionLargestRemainder({ a: 0.5, b: 0.3, c: 0.2 }, 10)).toEqual([
      { slug: 'a', count: 5 },
      { slug: 'b', count: 3 },
      { slug: 'c', count: 2 },
    ])
  })

  it('normalizes weights that do not sum to 1', () => {
    // 2:1 over 10 → exact 6.67 / 3.33 → floors 6/3, leftover 1 goes to the larger remainder.
    expect(apportionLargestRemainder({ a: 2, b: 1 }, 10)).toEqual([
      { slug: 'a', count: 7 },
      { slug: 'b', count: 3 },
    ])
  })

  it('keeps counts summing to batchSize when batchSize < number of arms', () => {
    const plan = apportionLargestRemainder({ a: 0.4, b: 0.35, c: 0.25 }, 2)
    expect(plan.reduce((acc, e) => acc + e.count, 0)).toBe(2)
    // Largest remainders (0.8, 0.7) win the two slots; c stays an explicit 0.
    expect(plan).toEqual([
      { slug: 'a', count: 1 },
      { slug: 'b', count: 1 },
      { slug: 'c', count: 0 },
    ])
  })

  it('gives a zero-weight arm an explicit 0', () => {
    expect(apportionLargestRemainder({ a: 1, b: 0 }, 5)).toEqual([
      { slug: 'a', count: 5 },
      { slug: 'b', count: 0 },
    ])
  })

  it('breaks equal remainders by slug order', () => {
    // Uniform over 4 arms, 2 slots: every remainder is 0.5 — a and b win.
    expect(apportionLargestRemainder({ d: 1, c: 1, b: 1, a: 1 }, 2)).toEqual([
      { slug: 'a', count: 1 },
      { slug: 'b', count: 1 },
      { slug: 'c', count: 0 },
      { slug: 'd', count: 0 },
    ])
  })

  it('returns [] for empty weights', () => {
    expect(apportionLargestRemainder({}, 30)).toEqual([])
  })

  it('throws on a non-positive weight sum', () => {
    expect(() => apportionLargestRemainder({ a: 0, b: 0 }, 10)).toThrow()
  })

  it('sums to batchSize across uneven distributions', () => {
    const weights = { a: 0.61, b: 0.17, c: 0.13, d: 0.09 }
    for (const batchSize of [1, 3, 7, 30, 100]) {
      const plan = apportionLargestRemainder(weights, batchSize)
      expect(plan.reduce((acc, e) => acc + e.count, 0)).toBe(batchSize)
    }
  })
})

describe('drawExploreSlots', () => {
  it('is deterministic under a seeded rng and sums to the slot count', () => {
    const weights = { a: 0.6, b: 0.3, c: 0.1 }
    const first = drawExploreSlots(weights, 20, seededRng('slots'))
    const second = drawExploreSlots(weights, 20, seededRng('slots'))
    expect(first).toEqual(second)
    expect(Object.values(first).reduce((acc, n) => acc + n, 0)).toBe(20)
  })

  it('never draws a zero-weight strategy', () => {
    const counts = drawExploreSlots({ a: 1, b: 0 }, 50, seededRng('zero'))
    expect(counts).toEqual({ a: 50 })
  })

  it('returns {} for empty weights or zero slots', () => {
    expect(drawExploreSlots({}, 5, seededRng('empty'))).toEqual({})
    expect(drawExploreSlots({ a: 1 }, 0, seededRng('none'))).toEqual({})
  })

  it('returns {} for a zero-sum distribution instead of collapsing onto one key', () => {
    expect(drawExploreSlots({ a: 0, b: 0 }, 5, seededRng('zerosum'))).toEqual({})
  })
})
