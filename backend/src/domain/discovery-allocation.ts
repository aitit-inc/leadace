import { weightedDraw } from './arm-bandit'

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
