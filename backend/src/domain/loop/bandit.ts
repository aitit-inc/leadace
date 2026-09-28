export type ArmStat = {
  armId: string
  total: number
  rewardSum: number
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

export const WILSON_Z = 1.96

// Channel affinity's ranking statistic (see allocation.ts); the bandits rank
// by P(best) (computePBest) instead.
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
