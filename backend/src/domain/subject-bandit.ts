import type { LeverConfig } from './lever-config'

export type VariantStat = {
  variantId: string
  total: number
  responses: number
  // Recorded for audit/metrics, not used for v1 selection: Wilson needs a
  // Bernoulli proportion, so the bandit optimizes reply-rate, not graded reward.
  rewardSum: number
}

export type ArchiveDecision = {
  variantId: string
  leaderLower: number
  armUpper: number
  n: number
}

export type WeightDecision = {
  weights: Record<string, number>
  toArchive: ArchiveDecision[]
  // True when the pool has converged to the >=2-active floor with a dominated
  // survivor kept alive only by that floor — the signal for /evaluate to supply
  // one fresh angle (the bandit prunes and re-weights but never generates).
  needsReplenishment: boolean
}

export const WILSON_Z = 1.96

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

const byVariantId = (a: VariantStat, b: VariantStat): number =>
  a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0

// `arms` is the active (non-archived) set; output weights are over survivors.
export function computeVariantWeights(arms: VariantStat[], config: LeverConfig): WeightDecision {
  const sorted = [...arms].sort(byVariantId)
  const k = sorted.length
  if (k === 0) return { weights: {}, toArchive: [], needsReplenishment: false }

  const uniform = (over: VariantStat[]): Record<string, number> =>
    Object.fromEntries(over.map((a) => [a.variantId, 1 / over.length]))

  // Gate on ≥2 mature (not "every arm mature") so a freshly-added variant
  // (total=0) can't pin a mature project to uniform forever.
  const mature = sorted.filter((a) => a.total >= config.minSamplePerArm)
  if (mature.length < 2) return { weights: uniform(sorted), toArchive: [], needsReplenishment: false }

  const bounds = new Map(mature.map((a) => [a.variantId, wilsonBounds(a.responses, a.total)] as const))
  let leader = mature[0]!
  for (const a of mature) {
    if (bounds.get(a.variantId)!.lower > bounds.get(leader.variantId)!.lower) leader = a
  }
  const leaderLower = bounds.get(leader.variantId)!.lower

  // Never the leader; never below 2 active arms (keep the worst-dominated when over the cap).
  const candidates: ArchiveDecision[] = mature
    .filter((a) => a.variantId !== leader.variantId && bounds.get(a.variantId)!.upper < leaderLower)
    .map((a) => ({ variantId: a.variantId, leaderLower, armUpper: bounds.get(a.variantId)!.upper, n: a.total }))
  const maxArchivable = Math.max(0, k - 2)
  const toArchive =
    candidates.length > maxArchivable
      ? [...candidates].sort((x, y) => x.armUpper - y.armUpper).slice(0, maxArchivable)
      : candidates

  const archivedIds = new Set(toArchive.map((a) => a.variantId))
  const survivors = sorted.filter((a) => !archivedIds.has(a.variantId))
  const ks = survivors.length
  const eps = config.explorationRate
  const floor = eps / ks
  const weights: Record<string, number> = {}
  for (const a of survivors) {
    weights[a.variantId] = a.variantId === leader.variantId ? 1 - eps + floor : floor
  }
  const sum = survivors.reduce((acc, a) => acc + weights[a.variantId]!, 0)
  for (const a of survivors) weights[a.variantId]! /= sum

  // Converged-and-thin: exactly the >=2 floor remains (no room to shed), on mature
  // data, and the leader still Wilson-dominates a survivor the floor is protecting.
  // Structural (no absolute reply-rate threshold), so it stays R5-safe and cannot
  // fire on a fresh / low-traffic project (mature.length < 2 returns above).
  const matureSurvivorCount = survivors.filter((a) => a.total >= config.minSamplePerArm).length
  const dominatedSurvivorExists = survivors.some(
    (a) => a.variantId !== leader.variantId && (bounds.get(a.variantId)?.upper ?? 1) < leaderLower,
  )
  const needsReplenishment = survivors.length <= 2 && matureSurvivorCount >= 2 && dominatedSurvivorExists
  return { weights, toArchive, needsReplenishment }
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

  const floor = config.explorationRate / k
  const raw: Record<string, number> = {}
  for (const id of activeVariantIds) {
    // A stored entry (incl. a deliberate 0 under epsilon=0) keeps its weight; a
    // brand-new variant absent from the vector gets the exploration floor.
    const w = storedWeights[id]
    raw[id] = w !== undefined && Number.isFinite(w) && w >= 0 ? w : floor
  }
  const sum = activeVariantIds.reduce((acc, id) => acc + raw[id]!, 0)
  if (sum <= 0) return uniform()
  return Object.fromEntries(activeVariantIds.map((id) => [id, raw[id]! / sum]))
}

export function weightedDraw(distribution: Record<string, number>, rng: () => number): string {
  const ids = Object.keys(distribution)
  if (ids.length === 0) throw new Error('weightedDraw: empty distribution')
  const total = ids.reduce((acc, id) => acc + distribution[id]!, 0)
  const target = rng() * total
  let cum = 0
  for (const id of ids) {
    cum += distribution[id]!
    if (target < cum) return id
  }
  return ids[ids.length - 1]! // float-sum underflow guard
}
