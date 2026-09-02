export type ArmStat = {
  armId: string
  total: number
  rewardSum: number
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

export function sampleBeta(alpha: number, beta: number, rng: () => number): number {
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
  arms: ArmStat[],
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): Record<string, number> {
  if (arms.length === 0) return {}
  if (arms.length === 1) return { [arms[0]!.armId]: 1 }
  const params = arms.map((a) => {
    const s = Math.min(Math.max(a.rewardSum, 0), a.total)
    return { armId: a.armId, alpha: 1 + s, beta: 1 + a.total - s }
  })
  const wins = new Map(params.map((p) => [p.armId, 0]))
  for (let i = 0; i < samples; i++) {
    let bestId = params[0]!.armId
    let best = -1
    for (const p of params) {
      const draw = sampleBeta(p.alpha, p.beta, rng)
      if (draw > best) {
        best = draw
        bestId = p.armId
      }
    }
    wins.set(bestId, wins.get(bestId)! + 1)
  }
  return Object.fromEntries(params.map((p) => [p.armId, wins.get(p.armId)! / samples]))
}

const byArmId = (a: ArmStat, b: ArmStat): number =>
  a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0

const posteriorMean = (a: ArmStat): number =>
  (1 + Math.min(Math.max(a.rewardSum, 0), a.total)) / (2 + a.total)

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
