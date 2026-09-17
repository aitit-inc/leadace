import { describe, it, expect } from 'vitest'
import {
  computeAxisLifts,
  overallMeanReward,
  LIFT_MAX,
  LIFT_MIN,
  PRIORITY_MULTIPLIERS,
  type TargetingAxisStat,
} from './targeting-score'

const stat = (value: string | null, total: number, rewardSum: number): TargetingAxisStat => ({
  value,
  total,
  rewardSum,
})

describe('overallMeanReward', () => {
  it('is the smoothed project mean', () => {
    // 200 sends, 10 reward → (10+1)/(200+2)
    expect(overallMeanReward([stat('a', 150, 8), stat(null, 50, 2)])).toBeCloseTo(11 / 202, 10)
  })

  it('never returns 0, even with no data (lift division stays defined)', () => {
    expect(overallMeanReward([])).toBeCloseTo(0.5, 10)
    expect(overallMeanReward([stat('a', 100, 0)])).toBeGreaterThan(0)
  })

  it('caps each bucket before summing, so the baseline stays a rate a bucket can reach', () => {
    // Every send engaged, so the rate is 1; unclamped the sum reads 15/14.
    expect(overallMeanReward([stat('a', 2, 4), stat('b', 10, 10)])).toBeCloseTo(13 / 14, 10)
  })
})

describe('computeAxisLifts', () => {
  const r0 = 0.05

  it('shrinks toward neutral at small n and moves with volume', () => {
    // Same observed rate (0.2), different volume: k=25 pseudo-sends at r0.
    const [small] = computeAxisLifts([stat('x', 5, 1)], r0, 25)
    const [large] = computeAxisLifts([stat('x', 100, 20)], r0, 25)
    expect(small!.lift).toBeGreaterThan(1)
    expect(large!.lift).toBeGreaterThan(small!.lift)
    // Exact shrinkage arithmetic for the small arm: (25·0.05 + 1)/(25 + 5)/0.05
    expect(small!.lift).toBeCloseTo((25 * 0.05 + 1) / 30 / 0.05, 10)
  })

  it('clamps to [0.5, 2.0] on both sides', () => {
    const [hot] = computeAxisLifts([stat('hot', 1000, 900)], r0, 25)
    const [cold] = computeAxisLifts([stat('cold', 10000, 0)], r0, 25)
    expect(hot!.lift).toBe(LIFT_MAX)
    expect(cold!.lift).toBe(LIFT_MIN)
  })

  it('keeps unseen buckets exactly neutral (R5: no data moves nothing)', () => {
    const lifts = computeAxisLifts([stat('unseen', 0, 0), stat(null, 0, 0)], r0, 25)
    expect(lifts.map((l) => l.lift)).toEqual([1.0, 1.0])
  })

  it('caps rewardSum at total (one send can draw several signals)', () => {
    // r0 = 1 keeps both arms clear of the [0.5, 2.0] clamp; at a realistic r0
    // it pins both at LIFT_MAX and hides the difference.
    const [over] = computeAxisLifts([stat('over', 2, 3)], 1, 25)
    const [full] = computeAxisLifts([stat('full', 2, 2)], 1, 25)
    expect(full!.lift).toBeCloseTo(1.0, 10)
    expect(over!.lift).toBe(full!.lift)
  })

  it('ranks the better-evidenced bucket higher when both fully engaged', () => {
    // r0 through overallMeanReward, not hand-picked: uncapped it inverts these.
    const stats = [stat('small', 2, 4), stat('large', 10, 10)]
    const [small, large] = computeAxisLifts(stats, overallMeanReward(stats), 25)
    expect(large!.lift).toBeGreaterThan(small!.lift)
  })

  it('preserves the null bucket as its own value', () => {
    const [nullBucket] = computeAxisLifts([stat(null, 50, 10)], r0, 25)
    expect(nullBucket!.value).toBeNull()
    expect(nullBucket!.lift).toBeGreaterThan(1)
  })
})

describe('PRIORITY_MULTIPLIERS', () => {
  it('spans a narrower range than the measured lift clamp (measurement outranks discretion)', () => {
    const values = Object.values(PRIORITY_MULTIPLIERS)
    const span = Math.max(...values) / Math.min(...values)
    expect(span).toBeLessThan(LIFT_MAX / LIFT_MIN)
  })

  it('is monotonically decreasing from priority 1 to 5 with 3 neutral', () => {
    expect(PRIORITY_MULTIPLIERS[3]).toBe(1.0)
    expect(PRIORITY_MULTIPLIERS[1]).toBeGreaterThan(PRIORITY_MULTIPLIERS[2])
    expect(PRIORITY_MULTIPLIERS[2]).toBeGreaterThan(PRIORITY_MULTIPLIERS[3])
    expect(PRIORITY_MULTIPLIERS[3]).toBeGreaterThan(PRIORITY_MULTIPLIERS[4])
    expect(PRIORITY_MULTIPLIERS[4]).toBeGreaterThan(PRIORITY_MULTIPLIERS[5])
  })
})
