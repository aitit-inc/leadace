import { describe, it, expect } from 'vitest'
import { seededRng, type ArmStat } from './bandit'
import {
  aggregateByCoarse,
  apportionLargestRemainder,
  computeAxisLifts,
  computeChannelAffinity,
  drawExploreSlots,
  floorAndNormalize,
  floorRescuedWeights,
  overallMeanReward,
  prepareDrawDistribution,
  LIFT_MAX,
  LIFT_MIN,
  PRIORITY_MULTIPLIERS,
  type ChannelCoarseStat,
  type ChannelFineStat,
  type TargetingAxisStat,
} from './allocation'
import { defaultLeverConfig, type LeverConfig } from './config'

const cfg = (over: Partial<LeverConfig> = {}): LeverConfig => ({ ...defaultLeverConfig, ...over })
const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + b, 0)
const arm = (armId: string, total = 0, rewardSum = 0): ArmStat => ({ armId, total, rewardSum })

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

describe('aggregateByCoarse', () => {
  it('sums two fine industries that share a coarse bucket + channel', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: 'B2B SaaS', total: 40, rewardSum: 4 },
      { channel: 'email', industry: 'AI / ML', total: 60, rewardSum: 9 },
    ]
    expect(aggregateByCoarse(rows)).toEqual([
      { channel: 'email', coarse: 'software_tech', total: 100, rewardSum: 13 },
    ])
  })

  it('keeps different channels and different buckets separate', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: 'B2B SaaS', total: 10, rewardSum: 1 },
      { channel: 'form', industry: 'B2B SaaS', total: 20, rewardSum: 2 },
      { channel: 'email', industry: 'Manufacturing', total: 30, rewardSum: 3 },
    ]
    const out = aggregateByCoarse(rows)
    expect(out).toHaveLength(3)
    expect(out).toContainEqual({ channel: 'form', coarse: 'software_tech', total: 20, rewardSum: 2 })
    expect(out).toContainEqual({ channel: 'email', coarse: 'hardware_industrial', total: 30, rewardSum: 3 })
  })

  it('folds null / unknown industry into other', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: null, total: 10, rewardSum: 1 },
      { channel: 'email', industry: 'made up', total: 5, rewardSum: 0 },
    ]
    expect(aggregateByCoarse(rows)).toEqual([
      { channel: 'email', coarse: 'other', total: 15, rewardSum: 1 },
    ])
  })
})

describe('computeChannelAffinity', () => {
  it('empty input → empty map', () => {
    expect(computeChannelAffinity([], cfg())).toEqual({})
  })

  it('drops channels under min-sample; omits a bucket with none mature', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 29, rewardSum: 10 },
      { channel: 'form', coarse: 'software_tech', total: 10, rewardSum: 5 },
    ]
    expect(computeChannelAffinity(stats, cfg())).toEqual({})
  })

  it('ranks mature channels by Wilson lower bound within a bucket', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 100, rewardSum: 20 }, // 20%
      { channel: 'form', coarse: 'software_tech', total: 100, rewardSum: 8 }, //  8%
      { channel: 'sns_linkedin', coarse: 'software_tech', total: 50, rewardSum: 1 }, //  2%
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['software_tech']!.map((r) => r.channel)).toEqual(['email', 'form', 'sns_linkedin'])
    expect(out['software_tech']![0]).toMatchObject({ channel: 'email', rate: 20, total: 100, rewardSum: 20 })
  })

  it('Wilson lower keeps a tiny-n high-rate channel from outranking a solid one', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'services', total: 30, rewardSum: 12 }, // 40% but n=30
      { channel: 'form', coarse: 'services', total: 400, rewardSum: 120 }, // 30% but n=400
    ]
    const out = computeChannelAffinity(stats, cfg())
    // form's lower bound (~25.8%) beats email's (~24.5%) despite the lower raw rate.
    expect(out['services']!.map((r) => r.channel)).toEqual(['form', 'email'])
  })

  it('surfaces a single mature channel as the measured preference', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'services', total: 50, rewardSum: 10 },
      { channel: 'form', coarse: 'services', total: 5, rewardSum: 3 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['services']).toEqual([{ channel: 'email', rate: 20, total: 50, rewardSum: 10 }])
  })

  it('keeps buckets independent', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 100, rewardSum: 5 },
      { channel: 'form', coarse: 'software_tech', total: 100, rewardSum: 15 },
      { channel: 'email', coarse: 'services', total: 100, rewardSum: 30 },
      { channel: 'form', coarse: 'services', total: 100, rewardSum: 10 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['software_tech']!.map((r) => r.channel)).toEqual(['form', 'email'])
    expect(out['services']!.map((r) => r.channel)).toEqual(['email', 'form'])
  })

  it('ranks by graded reward, so half-weight interest counts half', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'services', total: 100, rewardSum: 7.5 },
      { channel: 'form', coarse: 'services', total: 100, rewardSum: 5 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['services']).toEqual([
      { channel: 'email', rate: 7.5, total: 100, rewardSum: 7.5 },
      { channel: 'form', rate: 5, total: 100, rewardSum: 5 },
    ])
  })

  it('deterministic channel-name tie-break on identical stats', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'form', coarse: 'other', total: 100, rewardSum: 10 },
      { channel: 'email', coarse: 'other', total: 100, rewardSum: 10 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['other']!.map((r) => r.channel)).toEqual(['email', 'form'])
  })
})

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
