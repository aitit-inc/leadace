import type { LeverConfig } from './lever-config'
import {
  computeArmWeights,
  computePBest as computeArmPBest,
  floorRescuedWeights,
  rotateWeakestArm,
  type ArmStat,
  type ArmWeightDecision,
} from './arm-bandit'

export { seededRng, weightedDraw, PBEST_SAMPLES } from './arm-bandit'

export type VariantStat = {
  variantId: string
  total: number
  responses: number
  rewardSum: number
}

export type ArchiveDecision = {
  variantId: string
  // P(best) under the Thompson posterior at archive time. Wilson-era history
  // rows (pre-Phase-C) carry { leaderLower, armUpper } here instead.
  pBest: number
  n: number
  // Absent = dominance archive (P(best) below threshold at maturity).
  // 'stagnation' = rotation of the weakest arm after a flat-tick streak.
  reason?: 'stagnation'
}

export type WeightDecision = {
  weights: Record<string, number>
  // Raw P(best) per active arm (pre-floor): the audit trail and Phase-D
  // stagnation input; `weights` alone can't recover it once the floor applies.
  pBest: Record<string, number>
  toArchive: ArchiveDecision[]
}

export const WILSON_Z = 1.96

// Channel affinity's ranking statistic (see channel-affinity.ts); the message
// bandit itself is Thompson-based below.
export function wilsonBounds(
  successes: number,
  n: number,
  z: number = WILSON_Z,
): { lower: number; upper: number } {
  if (successes < 0 || n < 0) throw new Error(`wilsonBounds: negative input (successes=${successes}, n=${n})`)
  if (successes > n) throw new Error(`wilsonBounds: successes ${successes} > n ${n}`)
  if (n === 0) return { lower: 0, upper: 1 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))
  return { lower: Math.max(0, center - half), upper: Math.min(1, center + half) }
}

const toArm = (v: VariantStat): ArmStat => ({ armId: v.variantId, total: v.total, rewardSum: v.rewardSum })

const toVariantDecision = (d: ArmWeightDecision): WeightDecision => ({
  weights: d.weights,
  pBest: d.pBest,
  toArchive: d.toArchive.map(({ armId, ...rest }) => ({ variantId: armId, ...rest })),
})

export function computePBest(
  arms: VariantStat[],
  rng: () => number,
  samples?: number,
): Record<string, number> {
  return computeArmPBest(arms.map(toArm), rng, samples)
}

// `arms` is the active (non-archived) set; output weights are over survivors.
export function computeVariantWeights(
  arms: VariantStat[],
  config: LeverConfig,
  rng: () => number,
): WeightDecision {
  return toVariantDecision(computeArmWeights(
    arms.map(toArm),
    {
      minSamplePerArm: config.minSamplePerArm,
      archiveThreshold: config.archiveThreshold,
      weightFloor: config.messageWeightFloor,
    },
    rng,
  ))
}

// ---- Stagnation detection & rotation (Phase D) ----
//
// Stagnation is a structural signal, never an absolute response-rate threshold
// (R5): every active arm is mature yet no arm is more likely than not to be
// best — the send volume's resolution limit. With 2 arms the ceiling can never
// hold (their P(best) sum to 1), so a rotation always leaves >= 2 active arms.

export const STAGNATION_PBEST_CEILING = 0.5

export function isFlatTick(
  samples: VariantStat[],
  pBest: Record<string, number> | undefined,
  minSamplePerArm: number,
): boolean {
  if (!pBest || samples.length < 2) return false
  if (!samples.every((s) => s.total >= minSamplePerArm)) return false
  return samples.every((s) => (pBest[s.variantId] ?? 0) < STAGNATION_PBEST_CEILING)
}

export type StagnationTick = {
  variantIds: string[]
  flat: boolean
}

// `ticks` is newest first, today's (not yet persisted) tick at index 0. The
// streak also requires an unchanged arm set: any archive / replenish / manual
// pool edit resets the clock, which doubles as the post-rotation cooldown.
export function isStagnant(ticks: StagnationTick[], stagnationTicks: number): boolean {
  if (ticks.length < stagnationTicks) return false
  const window = ticks.slice(0, stagnationTicks)
  if (!window.every((t) => t.flat)) return false
  const ref = new Set(window[0]!.variantIds)
  return window.every((t) => t.variantIds.length === ref.size && t.variantIds.every((id) => ref.has(id)))
}

// Rotation frees a slot for a fresh angle (/evaluate supplies it — the service
// derives needsReplenishment from the persisted rotation row).
export function applyRotation(
  arms: VariantStat[],
  decision: WeightDecision,
  config: LeverConfig,
): WeightDecision {
  return toVariantDecision(rotateWeakestArm(
    arms.map(toArm),
    { weights: decision.weights, pBest: decision.pBest, toArchive: [] },
    config.messageWeightFloor,
  ))
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
