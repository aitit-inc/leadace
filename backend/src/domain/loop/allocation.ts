import type { Channel } from '../../db/schema'
import type { LeverConfig } from './config'
import { coarseIndustry, type CoarseIndustry } from '../coarse-industry'
import { weightedDraw, wilsonBounds, type ArmStat } from './bandit'

export type TargetingAxisStat = { value: string | null; total: number; rewardSum: number }
export type TargetingAxisLift = { value: string | null; lift: number }

// Arrays, not records: the null bucket needs no sentinel key in the jsonb.
export type TargetingStats = {
  industry: TargetingAxisStat[] // coarse-folded
  employeeBand: TargetingAxisStat[]
  country: TargetingAxisStat[]
  discoveryStrategy: TargetingAxisStat[]
}

export type TargetingLifts = {
  industry: TargetingAxisLift[] // value = coarse bucket
  employeeBand: TargetingAxisLift[]
  country: TargetingAxisLift[]
  discoveryStrategy: TargetingAxisLift[]
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

const clampLift = (v: number): number => Math.min(LIFT_MAX, Math.max(LIFT_MIN, v))

// rewardSum sums per-signal rewards, so one send drawing several exceeds total.
const clampReward = (rewardSum: number, total: number): number => Math.min(Math.max(rewardSum, 0), total)

// Add-one smoothing keeps r0 > 0 and stable at tiny n. Clamped per bucket, or
// the baseline lands above the rate any bucket can reach.
export function overallMeanReward(stats: TargetingAxisStat[]): number {
  let total = 0
  let reward = 0
  for (const s of stats) {
    total += s.total
    reward += clampReward(s.rewardSum, s.total)
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
    const posterior = (priorStrength * r0 + clampReward(rewardSum, total)) / (priorStrength + total)
    return { value, lift: clampLift(posterior / r0) }
  })
}

// The floor rescues an arm sunk by early bad luck: a low-P(best) arm with
// n < minSamplePerArm can never reach the archive gate, and without a floor
// it would draw ~no sends and stay a zombie forever. The floor is a share of
// the final vector: every survivor keeps at least `floor`, the remainder is
// apportioned by P(best). Flooring before normalizing let the share sink as
// arms accumulated (four arms at 0.1 came out at 0.087).
export function floorAndNormalize(
  survivors: ArmStat[],
  pBest: Record<string, number>,
  floor: number,
): Record<string, number> {
  const k = survivors.length
  if (k === 0) return {}
  // Uniform, not throw: dividing would persist NaN weights that silently
  // wedge weightedDraw on the last arm.
  const uniform = (): Record<string, number> => Object.fromEntries(survivors.map((a) => [a.armId, 1 / k]))
  const remainder = 1 - k * floor
  if (remainder <= 0) return uniform()
  const total = survivors.reduce((acc, a) => acc + pBest[a.armId]!, 0)
  if (total <= 0) return uniform()
  return Object.fromEntries(survivors.map((a) => [a.armId, floor + remainder * (pBest[a.armId]! / total)]))
}

// An id absent from the stored vector (registered since the last tick) enters
// at the floor — the same rescue the next tick would grant it.
export function floorRescuedWeights(
  ids: string[],
  stored: Record<string, number>,
  floor: number,
): Record<string, number> {
  return Object.fromEntries(ids.map((id) => {
    const w = stored[id]
    return [id, w !== undefined && Number.isFinite(w) && w >= 0 ? w : floor]
  }))
}

export function prepareDrawDistribution(
  activeVariantIds: string[],
  storedWeights: Record<string, number>,
  config: LeverConfig,
): Record<string, number> {
  const k = activeVariantIds.length
  if (k === 0) return {}
  const uniform = (): Record<string, number> => Object.fromEntries(activeVariantIds.map((id) => [id, 1 / k]))
  if (Object.keys(storedWeights).length === 0) return uniform()

  const raw = floorRescuedWeights(activeVariantIds, storedWeights, config.messageWeightFloor)
  const sum = activeVariantIds.reduce((acc, id) => acc + raw[id]!, 0)
  if (sum <= 0) return uniform()
  return Object.fromEntries(activeVariantIds.map((id) => [id, raw[id]! / sum]))
}

export type ChannelFineStat = {
  channel: Channel
  industry: string | null
  total: number
  responses: number
}

export type ChannelCoarseStat = {
  channel: Channel
  coarse: CoarseIndustry
  total: number
  responses: number
}

// Array order is the ranking; rate/total/responses are for transparency only.
export type ChannelRank = {
  channel: Channel
  rate: number
  total: number
  responses: number
}

// An absent bucket means "no measured preference, use policy order".
export type ChannelAffinityMap = Partial<Record<CoarseIndustry, ChannelRank[]>>

export function aggregateByCoarse(rows: ChannelFineStat[]): ChannelCoarseStat[] {
  const byKey = new Map<string, ChannelCoarseStat>()
  for (const r of rows) {
    const coarse = coarseIndustry(r.industry)
    const key = `${r.channel} ${coarse}`
    const entry = byKey.get(key)
    if (entry) {
      entry.total += r.total
      entry.responses += r.responses
    } else {
      byKey.set(key, { channel: r.channel, coarse, total: r.total, responses: r.responses })
    }
  }
  return Array.from(byKey.values())
}

// Ranked by Wilson lower bound, not raw rate, so a high rate on tiny n does not
// outrank a solid one.
export function computeChannelAffinity(
  stats: ChannelCoarseStat[],
  config: LeverConfig,
): ChannelAffinityMap {
  const byBucket = new Map<CoarseIndustry, ChannelCoarseStat[]>()
  for (const s of stats) {
    if (s.total < config.minSamplePerArm) continue
    const list = byBucket.get(s.coarse)
    if (list) list.push(s)
    else byBucket.set(s.coarse, [s])
  }

  const out: ChannelAffinityMap = {}
  for (const [coarse, list] of byBucket) {
    out[coarse] = [...list]
      .sort((a, b) => {
        const la = wilsonBounds(a.responses, a.total).lower
        const lb = wilsonBounds(b.responses, b.total).lower
        if (lb !== la) return lb - la
        const ra = a.responses / a.total
        const rb = b.responses / b.total
        if (rb !== ra) return rb - ra
        return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
      })
      .map((s) => ({
        channel: s.channel,
        rate: Math.round((s.responses / s.total) * 1000) / 10,
        total: s.total,
        responses: s.responses,
      }))
  }
  return out
}

export type BatchPlanEntry = { slug: string; count: number }

// Largest-remainder apportionment of a registration batch over the strategy
// weight distribution. Weights need not sum to 1 (normalized internally);
// entries are returned for every slug (a 0 count is an explicit "skip this
// strategy" instruction). Ties break by slug so the plan is deterministic.
export function apportionLargestRemainder(
  weights: Record<string, number>,
  batchSize: number,
): BatchPlanEntry[] {
  const slugs = Object.keys(weights).sort()
  if (slugs.length === 0) return []
  const total = slugs.reduce((acc, s) => acc + weights[s]!, 0)
  if (total <= 0) throw new Error('apportionLargestRemainder: non-positive weight sum')
  const entries = slugs.map((slug) => {
    const exact = (weights[slug]! / total) * batchSize
    const count = Math.floor(exact)
    return { slug, count, remainder: exact - count }
  })
  let leftover = batchSize - entries.reduce((acc, e) => acc + e.count, 0)
  const byRemainder = [...entries].sort(
    (a, b) => b.remainder - a.remainder || (a.slug < b.slug ? -1 : 1),
  )
  for (const e of byRemainder) {
    if (leftover === 0) break
    e.count += 1
    leftover -= 1
  }
  return entries.map(({ slug, count }) => ({ slug, count }))
}

// Stratified-exploration distribution: one weighted strategy draw per explore
// slot, aggregated to counts. The caller fills each stratum with a random
// reachable prospect of that strategy and falls back to a fully random pick
// for any shortfall. A distribution with no positive mass (empty, or every
// weight zeroed by a zero floor) returns {} — the caller's full-random
// fallback then owns every slot.
export function drawExploreSlots(
  weights: Record<string, number>,
  slots: number,
  rng: () => number,
): Record<string, number> {
  const counts: Record<string, number> = {}
  if (Object.values(weights).reduce((acc, w) => acc + w, 0) <= 0) return counts
  for (let i = 0; i < slots; i++) {
    const slug = weightedDraw(weights, rng)
    counts[slug] = (counts[slug] ?? 0) + 1
  }
  return counts
}
