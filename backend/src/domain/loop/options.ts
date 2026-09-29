import type { LeverConfig } from './config'
import { computePBest, PBEST_SAMPLES, type ArmStat } from './bandit'
import { floorAndNormalize } from './allocation'

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

export type ArmArchiveDecision = {
  armId: string
  // Dominance archive: P(best) among the mature arms; stagnation: among all active arms.
  pBest: number
  n: number
  // Absent = dominance archive (P(best) below threshold at maturity).
  // 'stagnation' = rotation of the weakest arm after a flat-tick streak.
  reason?: 'stagnation'
}

export type ArmWeightDecision = {
  weights: Record<string, number>
  // Raw P(best) per active arm (pre-floor): the audit trail and stagnation
  // input; `weights` alone can't recover it once the floor applies.
  pBest: Record<string, number>
  toArchive: ArmArchiveDecision[]
}

export type ArmBanditParams = {
  minSamplePerArm: number
  archiveThreshold: number
  weightFloor: number
}

const byArmId = (a: ArmStat, b: ArmStat): number =>
  a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0

const posteriorMean = (a: ArmStat): number =>
  (1 + Math.min(Math.max(a.rewardSum, 0), a.total)) / (2 + a.total)

// `arms` is the active (non-archived) set; output weights are over survivors.
// No maturity gate on the weights: allocation starts tilting from the first
// mature send (the upstream 14-day reward window is the only wait).
export function computeArmWeights(
  arms: ArmStat[],
  params: ArmBanditParams,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): ArmWeightDecision {
  const sorted = [...arms].sort(byArmId)
  const k = sorted.length
  if (k === 0) return { weights: {}, pBest: {}, toArchive: [] }

  const pBest = computePBest(sorted, rng, samples)

  // The archive verdict compares mature arms only. An immature arm's posterior
  // is mostly prior (Beta(1, 1) at n = 0 draws around 0.5), and against it
  // every measured arm at a realistic reply rate is a sure loser — one unsent
  // strategy was enough to archive the only arm with replies. Never below 2
  // active arms. When more arms qualify than may go, shed the worst P(best)
  // first; clear losers often tie at P(best) = 0, so the posterior mean breaks
  // the tie deterministically.
  const mature = sorted.filter((a) => a.total >= params.minSamplePerArm)
  // Same population → same estimate: a re-roll on the advanced stream could
  // disagree with the audited pBest right at the threshold.
  const pBestMature = mature.length === sorted.length ? pBest : computePBest(mature, rng, samples)
  const candidates = mature
    .filter((a) => pBestMature[a.armId]! < params.archiveThreshold)
    .map((a) => ({ decision: { armId: a.armId, pBest: pBestMature[a.armId]!, n: a.total }, mean: posteriorMean(a) }))
  const maxArchivable = Math.max(0, k - 2)
  const toArchive: ArmArchiveDecision[] = (
    candidates.length > maxArchivable
      ? [...candidates].sort((x, y) => x.decision.pBest - y.decision.pBest || x.mean - y.mean).slice(0, maxArchivable)
      : candidates
  ).map((c) => c.decision)

  const archivedIds = new Set(toArchive.map((a) => a.armId))
  const survivors = sorted.filter((a) => !archivedIds.has(a.armId))
  const weights = floorAndNormalize(survivors, pBest, params.weightFloor)

  return { weights, pBest, toArchive }
}

// Rotation = the only autonomous escape from a mediocre plateau: the dominance
// gate (P(best) < archiveThreshold) never fires when all arms are similarly
// mediocre, so the tick sheds the weakest arm to free a slot for a fresh angle.
// Weights are re-floored over the survivors from the same P(best).
export function rotateWeakestArm(
  arms: ArmStat[],
  decision: ArmWeightDecision,
  weightFloor: number,
): ArmWeightDecision {
  const weakest = [...arms].sort(
    (a, b) =>
      decision.pBest[a.armId]! - decision.pBest[b.armId]! ||
      posteriorMean(a) - posteriorMean(b) ||
      byArmId(a, b),
  )[0]!
  const survivors = arms.filter((a) => a.armId !== weakest.armId)
  return {
    weights: floorAndNormalize(survivors, decision.pBest, weightFloor),
    pBest: decision.pBest,
    toArchive: [{
      armId: weakest.armId,
      pBest: decision.pBest[weakest.armId]!,
      n: weakest.total,
      reason: 'stagnation',
    }],
  }
}

const toArm = (v: VariantStat): ArmStat => ({ armId: v.variantId, total: v.total, rewardSum: v.rewardSum })

const toVariantDecision = (d: ArmWeightDecision): WeightDecision => ({
  weights: d.weights,
  pBest: d.pBest,
  toArchive: d.toArchive.map(({ armId, ...rest }) => ({ variantId: armId, ...rest })),
})

export function computeVariantPBest(
  arms: VariantStat[],
  rng: () => number,
  samples?: number,
): Record<string, number> {
  return computePBest(arms.map(toArm), rng, samples)
}


// `arms` is the active (non-archived) set; output weights are over survivors.
export function computeVariantWeights(
  arms: VariantStat[],
  config: LeverConfig,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): WeightDecision {
  return toVariantDecision(computeArmWeights(
    arms.map(toArm),
    {
      minSamplePerArm: config.minSamplePerArm,
      archiveThreshold: config.archiveThreshold,
      weightFloor: config.messageWeightFloor,
    },
    rng,
    samples,
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
