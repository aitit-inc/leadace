// Candidate middle-layer rules from #793 design v2, prototyped here so the
// sweep can fix their values before they exist in production. Once chosen,
// they move into src/domain/loop (options.ts / allocation.ts, called from
// decide()) and the options experiment runs decide() for them too.
//
// - lost: an active option with n >= minSample that is unlikely to beat the
//   best mature option, archived-as-lost ones included. `compare` picks the
//   test: 'pool' = its P(best) among all those options is below lostBelow;
//   'leader' = P(it beats the leader) is below lostBelow, where the leader is
//   the mature option with the highest posterior mean. 'pool' thins every
//   P(best) as lost options pile up; 'leader' does not.
// - restore: a lost option whose score in that same test reaches restoreAt
//   goes back into a free slot before any new option is added.
// - slots: the active count is capped; a new option only fills a free slot.
// - immature cap: an option below minSample gets at most an even share of the
//   slots (not of today's survivors: options added after the decision enter
//   at the floor and must not push an immature share above it); the excess
//   goes to the mature options in proportion to their weights.

import { computePBest, type ArmStat } from '../src/domain/loop/bandit'
import { floorAndNormalize } from '../src/domain/loop/allocation'

export type ProposedParams = {
  minSample: number
  lostBelow: number
  restoreAt: number
  // Rotated options join the lost ones as restore candidates.
  restoreRotated: boolean
  slots: number
  compare: 'pool' | 'leader'
  // The current rules keep 2 (replenishment may not come); here a freed slot
  // is refilled in the same step, so 1 lets a 2-slot layer still drop a loser.
  minActive: number
  weightFloor: number
  capImmature: boolean
}

const byArmId = (a: ArmStat, b: ArmStat): number => (a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0)

const posteriorMean = (a: ArmStat): number =>
  (1 + Math.min(Math.max(a.rewardSum, 0), a.total)) / (2 + a.total)

export type LostJudgement = {
  lost: string[]
  // The test score of every mature option, active or lost; restore reads it too.
  pMature: Record<string, number>
}

function scoreMature(mature: ArmStat[], compare: ProposedParams['compare'], rng: () => number, samples: number): Record<string, number> {
  if (mature.length < 2) return {}
  if (compare === 'pool') return computePBest(mature, rng, samples)
  const leader = [...mature].sort((x, y) => posteriorMean(y) - posteriorMean(x) || byArmId(x, y))[0]!
  return Object.fromEntries(
    mature.map((a) => [a.armId, a.armId === leader.armId ? 1 : computePBest([a, leader], rng, samples)[a.armId]!]),
  )
}

export function judgeLost(
  active: ArmStat[],
  lostPool: ArmStat[],
  params: ProposedParams,
  rng: () => number,
  samples: number,
): LostJudgement {
  const mature = [...active, ...lostPool].filter((a) => a.total >= params.minSample).sort(byArmId)
  const pMature = scoreMature(mature, params.compare, rng, samples)
  const activeIds = new Set(active.map((a) => a.armId))
  const candidates = mature
    .filter((a) => activeIds.has(a.armId) && pMature[a.armId]! < params.lostBelow)
    .sort((x, y) => pMature[x.armId]! - pMature[y.armId]! || posteriorMean(x) - posteriorMean(y) || byArmId(x, y))
  const lost = candidates
    .slice(0, Math.max(0, active.length - params.minActive))
    .map((a) => a.armId)
  return { lost, pMature }
}

export function pickRestores(
  lostPool: ArmStat[],
  pMature: Record<string, number>,
  params: ProposedParams,
  freeSlots: number,
): string[] {
  return lostPool
    .filter((a) => (pMature[a.armId] ?? 0) >= params.restoreAt)
    .sort((x, y) => pMature[y.armId]! - pMature[x.armId]! || byArmId(x, y))
    .slice(0, Math.max(0, freeSlots))
    .map((a) => a.armId)
}

export function allocate(
  active: ArmStat[],
  params: ProposedParams,
  rng: () => number,
  samples: number,
): { weights: Record<string, number>; pBest: Record<string, number> } {
  const sorted = [...active].sort(byArmId)
  const pBest = computePBest(sorted, rng, samples)
  const floored = floorAndNormalize(sorted, pBest, params.weightFloor)
  return { weights: params.capImmature ? capImmature(sorted, floored, params.minSample, params.slots) : floored, pBest }
}

function capImmature(arms: ArmStat[], weights: Record<string, number>, minSample: number, slots: number): Record<string, number> {
  const mature = arms.filter((a) => a.total >= minSample)
  if (mature.length === 0) return Object.fromEntries(arms.map((a) => [a.armId, 1 / arms.length]))
  const cap = 1 / Math.max(slots, arms.length)
  const out = { ...weights }
  let excess = 0
  for (const a of arms) {
    if (a.total < minSample && out[a.armId]! > cap) {
      excess += out[a.armId]! - cap
      out[a.armId] = cap
    }
  }
  const matureSum = mature.reduce((acc, a) => acc + out[a.armId]!, 0)
  for (const a of mature) {
    out[a.armId]! += matureSum > 0 ? excess * (out[a.armId]! / matureSum) : excess / mature.length
  }
  return out
}
