import { describe, it, expect } from 'vitest'
import {
  computeAxisLifts,
  computeFreshSignalLifts,
  overallMeanReward,
  DEFAULT_FRESH_SIGNAL_LIFTS,
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

  it('preserves the null bucket as its own value', () => {
    const [nullBucket] = computeAxisLifts([stat(null, 50, 10)], r0, 25)
    expect(nullBucket!.value).toBeNull()
    expect(nullBucket!.lift).toBeGreaterThan(1)
  })
})

describe('computeFreshSignalLifts', () => {
  const r0 = 0.05

  it('keeps the default boost while a bucket is unmeasured', () => {
    const lifts = computeFreshSignalLifts(stat('with', 0, 0), stat('without', 0, 0), r0, 25)
    expect(lifts).toEqual(DEFAULT_FRESH_SIGNAL_LIFTS)
  })

  it('replaces a bucket with its measured lift once it has sends', () => {
    const lifts = computeFreshSignalLifts(stat('with', 0, 0), stat('without', 200, 2), r0, 25)
    expect(lifts.withSignal).toBe(DEFAULT_FRESH_SIGNAL_LIFTS.withSignal)
    expect(lifts.withoutSignal).toBeLessThan(1)
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
