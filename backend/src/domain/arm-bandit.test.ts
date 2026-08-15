import { describe, it, expect } from 'vitest'
import { floorAndNormalize, floorRescuedWeights, type ArmStat } from './arm-bandit'

const arm = (armId: string, total = 0, rewardSum = 0): ArmStat => ({ armId, total, rewardSum })

describe('floorAndNormalize', () => {
  it('floors low pBest and normalizes to 1', () => {
    const w = floorAndNormalize([arm('a'), arm('b')], { a: 0.9, b: 0.0 }, 0.1)
    expect(w.a).toBeCloseTo(0.9)
    expect(w.b).toBeCloseTo(0.1)
  })

  it('zero floor with all-zero pBest degrades to uniform, never NaN', () => {
    const w = floorAndNormalize([arm('a'), arm('b'), arm('c')], { a: 0, b: 0, c: 0 }, 0)
    expect(w).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })
  })

  it('empty survivors → empty weights', () => {
    expect(floorAndNormalize([], {}, 0.1)).toEqual({})
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
