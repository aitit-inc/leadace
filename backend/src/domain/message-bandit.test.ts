import { describe, it, expect } from 'vitest'
import {
  wilsonBounds,
  seededRng,
  computePBest,
  computeVariantWeights,
  prepareDrawDistribution,
  weightedDraw,
  isFlatTick,
  isStagnant,
  applyRotation,
  type StagnationTick,
  type VariantStat,
  type WeightDecision,
} from './message-bandit'
import { defaultLeverConfig, type LeverConfig } from './lever-config'

const cfg = (over: Partial<LeverConfig> = {}): LeverConfig => ({ ...defaultLeverConfig, ...over })
const arm = (variantId: string, total: number, rewardSum: number): VariantStat => ({
  variantId,
  total,
  responses: Math.min(Math.ceil(rewardSum), total),
  rewardSum,
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

describe('computePBest', () => {
  it('no arms → empty; single arm → certainty', () => {
    expect(computePBest([], seededRng('s'))).toEqual({})
    expect(computePBest([arm('a', 100, 50)], seededRng('s'))).toEqual({ a: 1 })
  })
  it('sums to 1 and favors the clearly better arm', () => {
    const p = computePBest([arm('a', 100, 50), arm('b', 100, 5)], seededRng('s'))
    expect(sum(p)).toBeCloseTo(1, 10)
    expect(p['a']!).toBeGreaterThan(0.95)
  })
  it('no data → roughly uniform (R5: nothing to favor)', () => {
    const p = computePBest([arm('a', 0, 0), arm('b', 0, 0), arm('c', 0, 0)], seededRng('s'))
    for (const id of ['a', 'b', 'c']) {
      expect(p[id]!).toBeGreaterThan(0.25)
      expect(p[id]!).toBeLessThan(0.42)
    }
  })
  it('multi-reply rewardSum above total is clamped, not a crash', () => {
    // One send can draw several countable replies: rewardSum 15 on total 10.
    const p = computePBest([arm('a', 10, 15), arm('b', 10, 2)], seededRng('s'))
    expect(Number.isFinite(p['a']!)).toBe(true)
    expect(sum(p)).toBeCloseTo(1, 10)
    expect(p['a']!).toBeGreaterThan(p['b']!)
  })
})

describe('computeVariantWeights (Thompson)', () => {
  it('no arms → empty', () => {
    expect(computeVariantWeights([], cfg(), seededRng('s'))).toEqual({
      weights: {},
      pBest: {},
      toArchive: [],
    })
  })
  it('deterministic under the same seed', () => {
    const arms = [arm('a', 60, 20), arm('b', 60, 10), arm('c', 30, 5)]
    const r1 = computeVariantWeights(arms, cfg(), seededRng('2026-07-14:p'))
    const r2 = computeVariantWeights(arms, cfg(), seededRng('2026-07-14:p'))
    expect(r1).toEqual(r2)
  })
  it('weights sum to 1 and tilt toward the stronger arm from the first data', () => {
    const { weights } = computeVariantWeights([arm('a', 20, 8), arm('b', 20, 2)], cfg(), seededRng('s'))
    expect(sum(weights)).toBeCloseTo(1, 10)
    expect(weights['a']!).toBeGreaterThan(weights['b']!)
  })
  it('floor keeps a sunk arm drawable (zombie rescue)', () => {
    const { weights, toArchive } = computeVariantWeights(
      [arm('a', 100, 50), arm('b', 20, 0), arm('c', 100, 40)],
      cfg(),
      seededRng('s'),
    )
    // b has ~zero P(best) but is immature (20 < 30): not archivable, floor-protected.
    expect(toArchive).toEqual([])
    expect(weights['b']!).toBeGreaterThan(0.03)
  })
  it('archives mature arms below the P(best) threshold', () => {
    const { weights, toArchive } = computeVariantWeights(
      [arm('a', 200, 60), arm('b', 200, 2), arm('c', 200, 1), arm('d', 200, 40)],
      cfg(),
      seededRng('s'),
    )
    const archived = toArchive.map((t) => t.variantId).sort()
    expect(archived).toEqual(['b', 'c'])
    for (const t of toArchive) {
      expect(t.pBest).toBeLessThan(0.05)
      expect(t.n).toBe(200)
    }
    expect(Object.keys(weights).sort()).toEqual(['a', 'd'])
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('immature arms are never archived', () => {
    const { toArchive } = computeVariantWeights(
      [arm('a', 100, 50), arm('b', 29, 0), arm('c', 100, 40)],
      cfg(),
      seededRng('s'),
    )
    expect(toArchive).toEqual([])
  })
  it('never archives below 2 active (k=2 dominated loser survives)', () => {
    const { weights, toArchive } = computeVariantWeights(
      [arm('a', 200, 100), arm('b', 200, 0)],
      cfg(),
      seededRng('s'),
    )
    expect(toArchive).toEqual([])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b'])
  })
  it('caps archiving to keep 2 active, shedding the worst P(best) first', () => {
    const { toArchive } = computeVariantWeights(
      [arm('a', 200, 100), arm('b', 200, 1), arm('c', 200, 2)],
      cfg(),
      seededRng('s'),
    )
    expect(toArchive.length).toBe(1)
    // b and c both tie at P(best) ≈ 0 — the posterior-mean tie-break sheds the weaker b.
    expect(toArchive[0]!.variantId).toBe('b')
  })
})

describe('prepareDrawDistribution', () => {
  it('no stored row → uniform', () => {
    expect(prepareDrawDistribution(['a', 'b'], {}, cfg())).toEqual({ a: 0.5, b: 0.5 })
  })
  it('empty active set → empty', () => {
    expect(prepareDrawDistribution([], { a: 1 }, cfg())).toEqual({})
  })
  it('new active arm gets the weight floor until the next tick', () => {
    const d = prepareDrawDistribution(['a', 'b', 'c'], { a: 0.8, b: 0.2 }, cfg())
    expect(d['c']!).toBeCloseTo(0.1 / 1.1, 10)
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
  it('respects a deliberate 0 weight', () => {
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
    const rng = seededRng('draw-frequency')
    const counts: Record<string, number> = { a: 0, b: 0 }
    const N = 20000
    for (let i = 0; i < N; i++) counts[weightedDraw({ a: 0.25, b: 0.75 }, rng)]!++
    expect(counts['a']! / N).toBeGreaterThan(0.22)
    expect(counts['a']! / N).toBeLessThan(0.28)
  })
})

describe('isFlatTick', () => {
  const min = defaultLeverConfig.minSamplePerArm
  it('all mature and max P(best) below the ceiling → flat', () => {
    const samples = [arm('a', 40, 4), arm('b', 40, 4), arm('c', 40, 4)]
    expect(isFlatTick(samples, { a: 0.34, b: 0.33, c: 0.33 }, min)).toBe(true)
  })
  it('one immature arm → not flat', () => {
    const samples = [arm('a', 40, 4), arm('b', 40, 4), arm('c', 10, 1)]
    expect(isFlatTick(samples, { a: 0.34, b: 0.33, c: 0.33 }, min)).toBe(false)
  })
  it('a leader at or above the ceiling → not flat', () => {
    const samples = [arm('a', 40, 8), arm('b', 40, 4), arm('c', 40, 4)]
    expect(isFlatTick(samples, { a: 0.5, b: 0.25, c: 0.25 }, min)).toBe(false)
  })
  it('missing pBest (pre-Phase-C row) → not flat', () => {
    expect(isFlatTick([arm('a', 40, 4), arm('b', 40, 4)], undefined, min)).toBe(false)
  })
  it('two arms can never be flat (their P(best) sum to 1)', () => {
    const samples = [arm('a', 40, 4), arm('b', 40, 4)]
    expect(isFlatTick(samples, { a: 0.5, b: 0.5 }, min)).toBe(false)
  })
})

describe('isStagnant', () => {
  const flat = (ids: string[]): StagnationTick => ({ variantIds: ids, flat: true })
  const moving = (ids: string[]): StagnationTick => ({ variantIds: ids, flat: false })
  const abc = ['a', 'b', 'c']
  it('exactly the required streak of flat same-set ticks → stagnant', () => {
    expect(isStagnant([flat(abc), flat(abc), flat(abc)], 3)).toBe(true)
  })
  it('fewer ticks than the streak length → not stagnant', () => {
    expect(isStagnant([flat(abc), flat(abc)], 3)).toBe(false)
  })
  it('one non-flat tick inside the window breaks the streak', () => {
    expect(isStagnant([flat(abc), moving(abc), flat(abc)], 3)).toBe(false)
  })
  it('an arm-set change inside the window breaks the streak', () => {
    expect(isStagnant([flat(abc), flat(['a', 'b', 'd']), flat(abc)], 3)).toBe(false)
  })
  it('only the newest window counts — older movement is irrelevant', () => {
    expect(isStagnant([flat(abc), flat(abc), flat(abc), moving(['a', 'b'])], 3)).toBe(true)
  })
})

describe('applyRotation', () => {
  const arms = [arm('a', 40, 6), arm('b', 40, 4), arm('c', 40, 5)]
  const decision: WeightDecision = {
    weights: { a: 0.4, b: 0.27, c: 0.33 },
    pBest: { a: 0.4, b: 0.27, c: 0.33 },
    toArchive: [],
  }
  it('archives the min-P(best) arm with the stagnation reason', () => {
    const rotated = applyRotation(arms, decision, cfg())
    expect(rotated.toArchive).toEqual([{ variantId: 'b', pBest: 0.27, n: 40, reason: 'stagnation' }])
  })
  it('re-floors weights over the survivors and keeps the full pBest map', () => {
    const rotated = applyRotation(arms, decision, cfg())
    expect(Object.keys(rotated.weights).sort()).toEqual(['a', 'c'])
    expect(sum(rotated.weights)).toBeCloseTo(1, 10)
    expect(rotated.weights['a']!).toBeGreaterThan(rotated.weights['c']!)
    expect(rotated.pBest).toEqual(decision.pBest)
  })
  it('P(best) tie breaks on posterior mean, then variantId', () => {
    const tied = [arm('a', 40, 6), arm('b', 40, 2), arm('c', 40, 5)]
    const d: WeightDecision = { ...decision, pBest: { a: 0.4, b: 0.3, c: 0.3 } }
    expect(applyRotation(tied, d, cfg()).toArchive[0]!.variantId).toBe('b')
    const evenMeans = [arm('a', 40, 5), arm('b', 40, 5), arm('c', 40, 6)]
    const d2: WeightDecision = { ...decision, pBest: { a: 0.3, b: 0.3, c: 0.4 } }
    expect(applyRotation(evenMeans, d2, cfg()).toArchive[0]!.variantId).toBe('a')
  })
})
