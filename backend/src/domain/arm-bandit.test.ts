import { describe, it, expect } from 'vitest'
import { computeArmWeights, floorAndNormalize, floorRescuedWeights, seededRng, type ArmStat } from './arm-bandit'

const arm = (armId: string, total = 0, rewardSum = 0): ArmStat => ({ armId, total, rewardSum })

describe('floorAndNormalize', () => {
  it('floors low pBest and normalizes to 1', () => {
    const w = floorAndNormalize([arm('a'), arm('b')], { a: 0.9, b: 0.0 }, 0.1)
    expect(w.a).toBeCloseTo(0.9)
    expect(w.b).toBeCloseTo(0.1)
  })

  it('every survivor keeps the floor after normalization (4 arms at 0.1 used to land at 0.087)', () => {
    const w = floorAndNormalize([arm('a'), arm('b'), arm('c'), arm('d')], { a: 0.85, b: 0.05, c: 0.05, d: 0.05 }, 0.1)
    for (const id of ['a', 'b', 'c', 'd']) expect(w[id]!).toBeGreaterThanOrEqual(0.1)
    expect(Object.values(w).reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 10)
    expect(w.a).toBeCloseTo(0.61, 10)
  })

  it('arms with zero pBest sit exactly at the floor; the rest splits the remainder by pBest', () => {
    const w = floorAndNormalize([arm('a'), arm('b'), arm('c')], { a: 0.9, b: 0.1, c: 0 }, 0.1)
    expect(w.c).toBeCloseTo(0.1, 10)
    expect(w.b).toBeCloseTo(0.17, 10)
    expect(w.a).toBeCloseTo(0.73, 10)
  })

  it('a floor the arm count cannot honor degrades to uniform', () => {
    expect(floorAndNormalize([arm('a'), arm('b'), arm('c')], { a: 1, b: 0, c: 0 }, 0.4)).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })
  })

  it('zero floor with all-zero pBest degrades to uniform, never NaN', () => {
    const w = floorAndNormalize([arm('a'), arm('b'), arm('c')], { a: 0, b: 0, c: 0 }, 0)
    expect(w).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })
  })

  it('empty survivors → empty weights', () => {
    expect(floorAndNormalize([], {}, 0.1)).toEqual({})
  })
})

const params = { minSamplePerArm: 30, archiveThreshold: 0.05, weightFloor: 0.1 }

describe('computeArmWeights archive gate', () => {
  it('unsent arms never archive the only measured arm (n=154 with 3 replies vs three at n=0)', () => {
    const { toArchive, weights } = computeArmWeights(
      [arm('measured', 154, 3), arm('u1'), arm('u2'), arm('u3')],
      params,
      seededRng('s'),
    )
    expect(toArchive).toEqual([])
    expect(weights['measured']!).toBeGreaterThanOrEqual(0.1)
  })

  it('a mature loser is still archived against a mature winner while an unsent arm is present', () => {
    const { toArchive, weights } = computeArmWeights(
      [arm('loser', 100, 0), arm('winner', 100, 20), arm('fresh')],
      params,
      seededRng('s'),
    )
    expect(toArchive.map((a) => a.armId)).toEqual(['loser'])
    expect(toArchive[0]!.pBest).toBeLessThan(0.05)
    expect(Object.keys(weights).sort()).toEqual(['fresh', 'winner'])
  })

  it('all-mature: the verdict and archived[].pBest use the returned pBest, not a re-roll', () => {
    const arms = [arm('a', 200, 60), arm('b', 200, 2), arm('c', 200, 40)]
    const { pBest, toArchive } = computeArmWeights(arms, params, seededRng('s'))
    expect(toArchive.map((t) => t.armId)).toEqual(['b'])
    expect(toArchive[0]!.pBest).toBe(pBest['b'])
    expect(Object.values(pBest).reduce((acc, x) => acc + x, 0)).toBeCloseTo(1, 10)
  })
})

describe('floorRescuedWeights', () => {
  it('keeps stored weights, floors missing ids', () => {
    expect(floorRescuedWeights(['a', 'b'], { a: 0.7 }, 0.1)).toEqual({ a: 0.7, b: 0.1 })
  })

  it('floors non-finite and negative stored values', () => {
    expect(floorRescuedWeights(['a', 'b'], { a: NaN, b: -1 }, 0.1)).toEqual({ a: 0.1, b: 0.1 })
  })

  it('zero floor leaves unweighed ids at zero', () => {
    expect(floorRescuedWeights(['a', 'b'], { a: 0.5 }, 0)).toEqual({ a: 0.5, b: 0 })
  })
})
