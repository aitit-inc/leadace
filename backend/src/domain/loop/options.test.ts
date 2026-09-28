import { describe, it, expect } from 'vitest'
import { seededRng, type ArmStat } from './bandit'
import {
  computeArmWeights,
  computeVariantPBest,
  computeVariantWeights,
  isFlatTick,
  isStagnant,
  applyRotation,
  type StagnationTick,
  type VariantStat,
  type WeightDecision,
} from './options'
import { defaultLeverConfig, type LeverConfig } from './config'

const cfg = (over: Partial<LeverConfig> = {}): LeverConfig => ({ ...defaultLeverConfig, ...over })
const arm = (variantId: string, total: number, rewardSum: number): VariantStat => ({
  variantId,
  total,
  responses: Math.min(Math.ceil(rewardSum), total),
  rewardSum,
})
const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + b, 0)

const armStat = (armId: string, total = 0, rewardSum = 0): ArmStat => ({ armId, total, rewardSum })

const params = { minSamplePerArm: 30, archiveThreshold: 0.05, weightFloor: 0.1 }

describe('computeArmWeights archive gate', () => {
  it('unsent arms never archive the only measured arm (n=154 with 3 replies vs three at n=0)', () => {
    const { toArchive, weights } = computeArmWeights(
      [armStat('measured', 154, 3), armStat('u1'), armStat('u2'), armStat('u3')],
      params,
      seededRng('s'),
    )
    expect(toArchive).toEqual([])
    expect(weights['measured']!).toBeGreaterThanOrEqual(0.1)
  })

  it('a mature loser is still archived against a mature winner while an unsent arm is present', () => {
    const { toArchive, weights } = computeArmWeights(
      [armStat('loser', 100, 0), armStat('winner', 100, 20), armStat('fresh')],
      params,
      seededRng('s'),
    )
    expect(toArchive.map((a) => a.armId)).toEqual(['loser'])
    expect(toArchive[0]!.pBest).toBeLessThan(0.05)
    expect(Object.keys(weights).sort()).toEqual(['fresh', 'winner'])
  })

  it('all-mature: the verdict and archived[].pBest use the returned pBest, not a re-roll', () => {
    const arms = [armStat('a', 200, 60), armStat('b', 200, 2), armStat('c', 200, 40)]
    const { pBest, toArchive } = computeArmWeights(arms, params, seededRng('s'))
    expect(toArchive.map((t) => t.armId)).toEqual(['b'])
    expect(toArchive[0]!.pBest).toBe(pBest['b'])
    expect(Object.values(pBest).reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 10)
  })
})

describe('computeVariantPBest', () => {
  it('no arms → empty; single arm → certainty', () => {
    expect(computeVariantPBest([], seededRng('s'))).toEqual({})
    expect(computeVariantPBest([arm('a', 100, 50)], seededRng('s'))).toEqual({ a: 1 })
  })
  it('sums to 1 and favors the clearly better arm', () => {
    const p = computeVariantPBest([arm('a', 100, 50), arm('b', 100, 5)], seededRng('s'))
    expect(sum(p)).toBeCloseTo(1, 10)
    expect(p['a']!).toBeGreaterThan(0.95)
  })
  it('no data → roughly uniform (R5: nothing to favor)', () => {
    const p = computeVariantPBest([arm('a', 0, 0), arm('b', 0, 0), arm('c', 0, 0)], seededRng('s'))
    for (const id of ['a', 'b', 'c']) {
      expect(p[id]!).toBeGreaterThan(0.25)
      expect(p[id]!).toBeLessThan(0.42)
    }
  })
  it('multi-reply rewardSum above total is clamped, not a crash', () => {
    // One send can draw several countable replies: rewardSum 15 on total 10.
    const p = computeVariantPBest([arm('a', 10, 15), arm('b', 10, 2)], seededRng('s'))
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
