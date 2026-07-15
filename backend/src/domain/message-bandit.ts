import type { LeverConfig } from './lever-config'

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

// Deterministic PRNG (xmur3 string hash → mulberry32) so the tick's Monte
// Carlo is reproducible from (cycle_date, projectId) for audit replay.
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  let a = (h ^ (h >>> 16)) >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Box–Muller; u clamped away from 0 to keep log finite.
function sampleStandardNormal(rng: () => number): number {
  const u = Math.max(rng(), Number.MIN_VALUE)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

// Marsaglia–Tsang (2000); requires shape >= 1, which Beta(1 + s, 1 + total − s)
// guarantees for both parameters.
function sampleGamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x: number
    let v: number
    do {
      x = sampleStandardNormal(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const x = sampleGamma(alpha, rng)
  const y = sampleGamma(beta, rng)
  return x / (x + y)
}

export const PBEST_SAMPLES = 10_000

// P(best) per arm under Beta(1 + s, 1 + total − s), s = clamp(rewardSum, 0, total).
// The clamp is load-bearing: rewardSum sums per-reply rewards, so one send with
// several countable replies can exceed total — unclamped, the second shape
// parameter goes non-positive. Treating fractional reward as Bernoulli successes
// is a deliberate approximation (fine for ~2x-resolution goals, not exact Thompson).
export function computePBest(
  arms: VariantStat[],
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): Record<string, number> {
  if (arms.length === 0) return {}
  if (arms.length === 1) return { [arms[0]!.variantId]: 1 }
  const params = arms.map((a) => {
    const s = Math.min(Math.max(a.rewardSum, 0), a.total)
    return { variantId: a.variantId, alpha: 1 + s, beta: 1 + a.total - s }
  })
  const wins = new Map(params.map((p) => [p.variantId, 0]))
  for (let i = 0; i < samples; i++) {
    let bestId = params[0]!.variantId
    let best = -1
    for (const p of params) {
      const draw = sampleBeta(p.alpha, p.beta, rng)
      if (draw > best) {
        best = draw
        bestId = p.variantId
      }
    }
    wins.set(bestId, wins.get(bestId)! + 1)
  }
  return Object.fromEntries(params.map((p) => [p.variantId, wins.get(p.variantId)! / samples]))
}

const byVariantId = (a: VariantStat, b: VariantStat): number =>
  a.variantId < b.variantId ? -1 : a.variantId > b.variantId ? 1 : 0

const posteriorMean = (a: VariantStat): number =>
  (1 + Math.min(Math.max(a.rewardSum, 0), a.total)) / (2 + a.total)

// The floor rescues an arm sunk by early bad luck: a low-P(best) arm with
// n < minSamplePerArm can never reach the archive gate, and without a floor
// it would draw ~no sends and stay a zombie forever.
function floorAndNormalize(
  survivors: VariantStat[],
  pBest: Record<string, number>,
  floor: number,
): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const a of survivors) raw[a.variantId] = Math.max(pBest[a.variantId]!, floor)
  const total = survivors.reduce((acc, a) => acc + raw[a.variantId]!, 0)
  return Object.fromEntries(survivors.map((a) => [a.variantId, raw[a.variantId]! / total]))
}

// `arms` is the active (non-archived) set; output weights are over survivors.
// No maturity gate on the weights: allocation starts tilting from the first
// mature send (the upstream 14-day reward window is the only wait).
export function computeVariantWeights(
  arms: VariantStat[],
  config: LeverConfig,
  rng: () => number,
): WeightDecision {
  const sorted = [...arms].sort(byVariantId)
  const k = sorted.length
  if (k === 0) return { weights: {}, pBest: {}, toArchive: [] }

  const pBest = computePBest(sorted, rng)

  // Archive on mature data only; never below 2 active arms. When more arms
  // qualify than may go, shed the worst P(best) first; clear losers often tie
  // at P(best) = 0, so the posterior mean breaks the tie deterministically.
  const candidates = sorted
    .filter((a) => a.total >= config.minSamplePerArm && pBest[a.variantId]! < config.archiveThreshold)
    .map((a) => ({ decision: { variantId: a.variantId, pBest: pBest[a.variantId]!, n: a.total }, mean: posteriorMean(a) }))
  const maxArchivable = Math.max(0, k - 2)
  const toArchive: ArchiveDecision[] = (
    candidates.length > maxArchivable
      ? [...candidates].sort((x, y) => x.decision.pBest - y.decision.pBest || x.mean - y.mean).slice(0, maxArchivable)
      : candidates
  ).map((c) => c.decision)

  const archivedIds = new Set(toArchive.map((a) => a.variantId))
  const survivors = sorted.filter((a) => !archivedIds.has(a.variantId))
  const weights = floorAndNormalize(survivors, pBest, config.messageWeightFloor)

  return { weights, pBest, toArchive }
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

// Rotation = the only autonomous escape from a mediocre plateau: the dominance
// gate (P(best) < archiveThreshold) never fires when all arms are similarly
// mediocre, so the tick sheds the weakest arm to free a slot for a fresh angle
// (/evaluate supplies it — the service derives needsReplenishment from the
// persisted rotation row). Weights are re-floored over the survivors from the
// same P(best).
export function applyRotation(
  arms: VariantStat[],
  decision: WeightDecision,
  config: LeverConfig,
): WeightDecision {
  const weakest = [...arms].sort(
    (a, b) =>
      decision.pBest[a.variantId]! - decision.pBest[b.variantId]! ||
      posteriorMean(a) - posteriorMean(b) ||
      byVariantId(a, b),
  )[0]!
  const survivors = arms.filter((a) => a.variantId !== weakest.variantId)
  return {
    weights: floorAndNormalize(survivors, decision.pBest, config.messageWeightFloor),
    pBest: decision.pBest,
    toArchive: [{
      variantId: weakest.variantId,
      pBest: decision.pBest[weakest.variantId]!,
      n: weakest.total,
      reason: 'stagnation',
    }],
  }
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

  const raw: Record<string, number> = {}
  for (const id of activeVariantIds) {
    // A stored entry keeps its weight; a brand-new variant absent from the
    // vector gets the floor (pre-normalization scale) until the next tick weighs it.
    const w = storedWeights[id]
    raw[id] = w !== undefined && Number.isFinite(w) && w >= 0 ? w : config.messageWeightFloor
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
