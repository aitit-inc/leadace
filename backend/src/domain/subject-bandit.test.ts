import { describe, it, expect } from 'vitest'
import {
  wilsonBounds,
  computeVariantWeights,
  prepareDrawDistribution,
  weightedDraw,
  type VariantStat,
} from './subject-bandit'
import { defaultLeverConfig, type LeverConfig } from './lever-config'

const cfg = (over: Partial<LeverConfig> = {}): LeverConfig => ({ ...defaultLeverConfig, ...over })
const arm = (variantId: string, total: number, responses: number): VariantStat => ({
  variantId,
  total,
  responses,
  rewardSum: responses, // value irrelevant to v1 selection
})
const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + b, 0)

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
  it('large n tightens around p', () => {
    const { lower, upper } = wilsonBounds(500, 1000)
    expect(lower).toBeLessThan(0.5)
    expect(upper).toBeGreaterThan(0.5)
    expect(upper - lower).toBeLessThan(0.1)
  })
  it('throws on invalid input', () => {
    expect(() => wilsonBounds(5, 3)).toThrow()
    expect(() => wilsonBounds(-1, 10)).toThrow()
  })
})

describe('computeVariantWeights', () => {
  it('no arms → empty', () => {
    expect(computeVariantWeights([], cfg())).toEqual({ weights: {}, toArchive: [], needsReplenishment: false })
  })
  it('single arm → weight 1', () => {
    const { weights, toArchive } = computeVariantWeights([arm('a', 100, 50)], cfg())
    expect(weights).toEqual({ a: 1 })
    expect(toArchive).toEqual([])
  })
  it('all arms under min-sample → exactly uniform (invariant #1)', () => {
    const { weights, toArchive } = computeVariantWeights([arm('a', 10, 5), arm('b', 10, 1)], cfg())
    expect(weights).toEqual({ a: 0.5, b: 0.5 })
    expect(toArchive).toEqual([])
  })
  it('min-sample boundary: 29 immature, 30 mature', () => {
    // one mature + one immature → still <2 mature → uniform
    const r29 = computeVariantWeights([arm('a', 29, 20), arm('b', 30, 1)], cfg())
    expect(r29.weights).toEqual({ a: 0.5, b: 0.5 })
    // both exactly at 30 → 2 mature → estimator engages, leader concentrates
    const r30 = computeVariantWeights([arm('a', 30, 20), arm('b', 30, 1)], cfg())
    expect(r30.weights['a']!).toBeGreaterThan(r30.weights['b']!)
  })
  it('newborn does not pin a mature project to uniform', () => {
    // Three close mature arms (no archiving) plus a brand-new arm.
    const { weights, toArchive } = computeVariantWeights(
      [arm('a', 50, 25), arm('b', 50, 24), arm('c', 50, 23), arm('d', 0, 0)],
      cfg(),
    )
    // estimator ran (not uniform); newborn d kept at the exploration floor ε/ks
    expect(weights['a']!).toBeGreaterThan(weights['d']!)
    expect(weights['d']!).toBeCloseTo(0.2 / 4, 10) // no archive here → ks=4
    expect(toArchive).toEqual([])
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('all-zero responses → deterministic leader, no archive', () => {
    const { weights, toArchive } = computeVariantWeights([arm('b', 50, 0), arm('a', 50, 0)], cfg())
    expect(toArchive).toEqual([])
    // tie on lower bound (all 0) → smallest variantId 'a' leads
    expect(weights['a']!).toBeGreaterThan(weights['b']!)
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('clear losers archived, leaving ≥2 active', () => {
    const { weights, toArchive } = computeVariantWeights(
      [arm('a', 60, 30), arm('b', 60, 28), arm('c', 50, 1), arm('d', 50, 0)],
      cfg(),
    )
    const archived = toArchive.map((t) => t.variantId).sort()
    expect(archived).toEqual(['c', 'd'])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b'])
    expect(sum(weights)).toBeCloseTo(1, 10)
    for (const t of toArchive) expect(t.armUpper).toBeLessThan(t.leaderLower)
  })
  it('never archives below 2 active (k=2 dominated loser survives)', () => {
    const { weights, toArchive } = computeVariantWeights([arm('a', 50, 25), arm('b', 50, 0)], cfg())
    expect(toArchive).toEqual([])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b'])
  })
  it('caps archiving to keep 2 active when more are dominated', () => {
    const { toArchive } = computeVariantWeights(
      [arm('a', 60, 40), arm('b', 50, 0), arm('c', 50, 0)],
      cfg(),
    )
    // k=3 → maxArchivable=1; both b,c dominated but only one may go
    expect(toArchive.length).toBe(1)
  })
  it('epsilon=0 → pure exploitation', () => {
    const { weights } = computeVariantWeights(
      [arm('a', 50, 30), arm('b', 50, 5), arm('c', 50, 4)],
      cfg({ explorationRate: 0 }),
    )
    // c is dominated and gets archived; a leads survivors {a,b}
    expect(weights['a']!).toBe(1)
    expect(weights['b']).toBe(0)
  })
  it('epsilon=1 → uniform over survivors', () => {
    const { weights } = computeVariantWeights(
      [arm('a', 50, 25), arm('b', 50, 24)],
      cfg({ explorationRate: 1 }),
    )
    expect(weights['a']!).toBeCloseTo(0.5, 10)
    expect(weights['b']!).toBeCloseTo(0.5, 10)
  })
})

describe('computeVariantWeights — needsReplenishment', () => {
  it('false when fresh / under min-sample (invariant #1)', () => {
    expect(computeVariantWeights([arm('a', 10, 5), arm('b', 10, 1)], cfg()).needsReplenishment).toBe(false)
    expect(computeVariantWeights([], cfg()).needsReplenishment).toBe(false)
    expect(computeVariantWeights([arm('a', 100, 50)], cfg()).needsReplenishment).toBe(false)
  })
  it('false for a healthy 2-way race (neither arm dominates)', () => {
    expect(computeVariantWeights([arm('a', 50, 25), arm('b', 50, 24)], cfg()).needsReplenishment).toBe(false)
  })
  it('false while there is still room to shed (3 mature, none dominated)', () => {
    expect(
      computeVariantWeights([arm('a', 50, 25), arm('b', 50, 24), arm('c', 50, 23)], cfg()).needsReplenishment,
    ).toBe(false)
  })
  it('true when converged to the floor with a dominated survivor (k=2)', () => {
    const r = computeVariantWeights([arm('a', 50, 25), arm('b', 50, 0)], cfg())
    expect(r.toArchive).toEqual([]) // the ≥2 floor protects the dominated loser
    expect(r.needsReplenishment).toBe(true)
  })
  it('true when archiving caps to 2 active and the survivor is still dominated', () => {
    const r = computeVariantWeights([arm('a', 60, 40), arm('b', 50, 0), arm('c', 50, 0)], cfg())
    expect(r.toArchive.length).toBe(1)
    expect(r.needsReplenishment).toBe(true)
  })
})

describe('prepareDrawDistribution', () => {
  it('no stored row → uniform', () => {
    expect(prepareDrawDistribution(['a', 'b'], {}, cfg())).toEqual({ a: 0.5, b: 0.5 })
  })
  it('empty active set → empty', () => {
    expect(prepareDrawDistribution([], { a: 1 }, cfg())).toEqual({})
  })
  it('new active arm gets the exploration floor', () => {
    const d = prepareDrawDistribution(['a', 'b', 'c'], { a: 0.8, b: 0.2 }, cfg())
    expect(d['c']!).toBeGreaterThan(0)
    expect(d['a']!).toBeGreaterThan(d['b']!)
    expect(sum(d)).toBeCloseTo(1, 10)
  })
  it('stored arms no longer active are dropped and mass redistributes', () => {
    const d = prepareDrawDistribution(['a', 'b'], { a: 0.5, b: 0.3, c: 0.2 }, cfg())
    expect(d['c']).toBeUndefined()
    expect(sum(d)).toBeCloseTo(1, 10)
    expect(d['a']! / d['b']!).toBeCloseTo(0.5 / 0.3, 6)
  })
  it('disjoint stored/active → effectively uniform', () => {
    const d = prepareDrawDistribution(['x', 'y'], { a: 1 }, cfg())
    expect(d['x']!).toBeCloseTo(0.5, 10)
    expect(d['y']!).toBeCloseTo(0.5, 10)
  })
  it('drifted stored weights renormalize', () => {
    const d = prepareDrawDistribution(['a', 'b'], { a: 2, b: 2 }, cfg())
    expect(sum(d)).toBeCloseTo(1, 10)
    expect(d['a']!).toBeCloseTo(0.5, 10)
  })
  it('respects a deliberate 0 weight (epsilon=0 arm)', () => {
    const d = prepareDrawDistribution(['a', 'b'], { a: 1, b: 0 }, cfg())
    expect(d['b']).toBe(0)
    expect(d['a']).toBe(1)
  })
  it('corrupt stored value falls back to the floor', () => {
    const d = prepareDrawDistribution(['a', 'b'], { a: Number.NaN, b: 0.5 }, cfg())
    expect(Number.isFinite(d['a']!)).toBe(true)
    expect(sum(d)).toBeCloseTo(1, 10)
  })
  it('single active arm → weight 1', () => {
    expect(prepareDrawDistribution(['a'], { a: 0.9, b: 0.1 }, cfg())).toEqual({ a: 1 })
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
    // Deterministic LCG so the test is reproducible without Math.random.
    let s = 123456789
    const rng = (): number => {
      s = (1103515245 * s + 12345) % 2147483648
      return s / 2147483648
    }
    const counts: Record<string, number> = { a: 0, b: 0 }
    const N = 20000
    for (let i = 0; i < N; i++) counts[weightedDraw({ a: 0.25, b: 0.75 }, rng)]!++
    expect(counts['a']! / N).toBeGreaterThan(0.22)
    expect(counts['a']! / N).toBeLessThan(0.28)
  })
})
