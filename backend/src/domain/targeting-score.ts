export type TargetingAxisStat = { value: string | null; total: number; rewardSum: number }
export type TargetingAxisLift = { value: string | null; lift: number }

// Arrays, not records: the null bucket needs no sentinel key in the jsonb.
export type TargetingLifts = {
  industry: TargetingAxisLift[] // value = coarse bucket
  employeeBand: TargetingAxisLift[]
  country: TargetingAxisLift[]
  discoveryStrategy: TargetingAxisLift[]
  freshSignal: { withSignal: number; withoutSignal: number }
}

// Applied per axis AND on the composite — an unclamped 4-axis product
// compounds to 16x and gets hypersensitive to small-n flukes.
export const LIFT_MIN = 0.5
export const LIFT_MAX = 2.0

// Range (3x) deliberately narrower than the measured composite (4x) so
// measurement outranks operator/LLM discretion once data exists.
export const PRIORITY_MULTIPLIERS: Readonly<Record<1 | 2 | 3 | 4 | 5, number>> = {
  1: 1.5,
  2: 1.2,
  3: 1.0,
  4: 0.8,
  5: 0.5,
}

// Pre-measurement defaults ≈ the old fixed one-priority-step boost.
export const DEFAULT_FRESH_SIGNAL_LIFTS = { withSignal: 1.25, withoutSignal: 1.0 } as const

const clampLift = (v: number): number => Math.min(LIFT_MAX, Math.max(LIFT_MIN, v))

// Add-one smoothing keeps r0 > 0 and stable at tiny n.
export function overallMeanReward(stats: TargetingAxisStat[]): number {
  let total = 0
  let reward = 0
  for (const s of stats) {
    total += s.total
    reward += s.rewardSum
  }
  return (reward + 1) / (total + 2)
}

// total = 0 stays exactly neutral so unseen buckets never move the ordering.
export function computeAxisLifts(
  stats: TargetingAxisStat[],
  r0: number,
  priorStrength: number,
): TargetingAxisLift[] {
  return stats.map(({ value, total, rewardSum }) => {
    if (total === 0) return { value, lift: 1.0 }
    const posterior = (priorStrength * r0 + rewardSum) / (priorStrength + total)
    return { value, lift: clampLift(posterior / r0) }
  })
}

// Time-varying flag → never materialized; applied at read time. An unmeasured
// bucket keeps its default so the prior boost survives until measured.
export function computeFreshSignalLifts(
  withSignal: TargetingAxisStat,
  withoutSignal: TargetingAxisStat,
  r0: number,
  priorStrength: number,
): TargetingLifts['freshSignal'] {
  const measured = (stat: TargetingAxisStat, fallback: number): number => {
    if (stat.total === 0) return fallback
    const posterior = (priorStrength * r0 + stat.rewardSum) / (priorStrength + stat.total)
    return clampLift(posterior / r0)
  }
  return {
    withSignal: measured(withSignal, DEFAULT_FRESH_SIGNAL_LIFTS.withSignal),
    withoutSignal: measured(withoutSignal, DEFAULT_FRESH_SIGNAL_LIFTS.withoutSignal),
  }
}
