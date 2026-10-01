import { computePBest, PBEST_SAMPLES, type ArmStat } from './bandit'
import { floorAndNormalize } from './allocation'

// An active option. `sinceEntry` counts its mature sends since it last entered
// the active set (added or restored, by anyone).
export type OptionArm = ArmStat & { sinceEntry: number }

// Each carries the probability the rule held against its threshold: of beating
// the leader for a lost or restored option, of being best among the active set
// for the weakest arm a flat set rotates out.
export type ArmArchiveDecision =
  | { armId: string; n: number; pBeatsLeader: number }
  | { armId: string; n: number; pBest: number; reason: 'stagnation' }

export type ArmRestoreDecision = { armId: string; n: number; pBeatsLeader: number }

export type OptionsDecision = {
  weights: Record<string, number>
  // Raw P(best) per active arm (pre-floor): `weights` alone can't recover it
  // once the floor and the cap apply.
  pBest: Record<string, number>
  toArchive: ArmArchiveDecision[]
  toRestore: ArmRestoreDecision[]
  // Days in a row the set has been flat, today included; 0 for a layer that
  // never rotates.
  flatStreak: number
}

export type OptionRuleParams = {
  minSamplePerArm: number
  archiveThreshold: number
  restoreThreshold: number
  // What the rule and Ace fill up to; a person may hold more.
  slots: number
  weightFloor: number
}

// Rotation is a layer's own choice: null for a layer that never rotates.
export type RotationInput = {
  // Days in a row the set had been flat as of the last decision.
  flatStreak: number
  stagnationDays: number
}

const MIN_ACTIVE = 2

const byArmId = (a: ArmStat, b: ArmStat): number =>
  a.armId < b.armId ? -1 : a.armId > b.armId ? 1 : 0

const posteriorMean = (a: ArmStat): number =>
  (1 + Math.min(Math.max(a.rewardSum, 0), a.total)) / (2 + a.total)

// Every proven option, active or lost, against the leader: the proven option
// with the highest posterior mean. One-on-one, so the score of an option does
// not thin as lost options pile up (a P(best) among all of them would).
function scoreAgainstLeader(proven: ArmStat[], rng: () => number, samples: number): Record<string, number> {
  if (proven.length < 2) return {}
  const leader = [...proven].sort((x, y) => posteriorMean(y) - posteriorMean(x) || byArmId(x, y))[0]!
  return Object.fromEntries(
    proven.map((a) => [a.armId, a.armId === leader.armId ? 1 : computePBest([a, leader], rng, samples)[a.armId]!]),
  )
}

// An option below minSamplePerArm gets at most an even share of the slots (not
// of today's set: options added after the decision enter at the floor and must
// not push an unproven share above it); the excess goes to the proven options
// in proportion to their weights.
function capUnproven(arms: ArmStat[], weights: Record<string, number>, params: OptionRuleParams): Record<string, number> {
  const proven = arms.filter((a) => a.total >= params.minSamplePerArm)
  if (proven.length === 0) return Object.fromEntries(arms.map((a) => [a.armId, 1 / arms.length]))
  const cap = 1 / Math.max(params.slots, arms.length)
  const out = { ...weights }
  let excess = 0
  for (const a of arms) {
    if (a.total < params.minSamplePerArm && out[a.armId]! > cap) {
      excess += out[a.armId]! - cap
      out[a.armId] = cap
    }
  }
  const provenSum = proven.reduce((acc, a) => acc + out[a.armId]!, 0)
  for (const a of proven) {
    out[a.armId]! += provenSum > 0 ? excess * (out[a.armId]! / provenSum) : excess / proven.length
  }
  return out
}

// Stagnation is a structural signal, never an absolute response-rate threshold
// (R5): every active arm is proven and out of its grace, yet none is more
// likely than not to be best — the send volume's resolution limit. With 2 arms
// the ceiling can never hold (their P(best) sum to 1), so a rotation always
// leaves >= 2 active arms.
export const STAGNATION_PBEST_CEILING = 0.5

export function isFlat(arms: OptionArm[], pBest: Record<string, number>, minSamplePerArm: number): boolean {
  if (arms.length < 2) return false
  if (!arms.every((a) => a.total >= minSamplePerArm && a.sinceEntry >= minSamplePerArm)) return false
  return arms.every((a) => pBest[a.armId]! < STAGNATION_PBEST_CEILING)
}

// One layer's daily decision, in order: drop what lost, rotate a flat set,
// bring back what recovered, weigh what runs.
//
// - lost: a proven active option, out of its grace, unlikely to beat the
//   leader. The verdict compares proven options only: an unproven posterior is
//   mostly prior (Beta(1, 1) at n = 0 draws around 0.5), and against it every
//   measured option at a realistic reply rate is a sure loser. Never below 2
//   active; when more qualify than may go, the worst score goes first, then
//   the lower posterior mean (clear losers tie at 0).
// - rotation: the dominance test never fires when every option is similarly
//   mediocre, so a set that has been flat stagnationDays in a row sheds its
//   weakest arm, freeing a slot for a fresh angle. A day something was lost
//   is movement and starts the count over, as does a new or restored option
//   (unproven or in its grace, so the set is not flat).
// - restore: a lost option whose score has recovered goes back into a free
//   slot, before /evaluate fills one with something new.
// - grace: an option is judged only once its own sends since it entered reach
//   minSamplePerArm, so one a person or the rule just brought back is not
//   dropped on the record that got it archived.
export function decideOptions(
  active: OptionArm[],
  lost: ArmStat[],
  params: OptionRuleParams,
  rotation: RotationInput | null,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): OptionsDecision {
  const arms = [...active].sort(byArmId)
  const pool = [...lost].sort(byArmId)
  const proven = [...arms, ...pool].filter((a) => a.total >= params.minSamplePerArm).sort(byArmId)
  const score = scoreAgainstLeader(proven, rng, samples)

  const toArchive: ArmArchiveDecision[] = arms
    .filter((a) => a.sinceEntry >= params.minSamplePerArm && score[a.armId] !== undefined && score[a.armId]! < params.archiveThreshold)
    .sort((x, y) => score[x.armId]! - score[y.armId]! || posteriorMean(x) - posteriorMean(y) || byArmId(x, y))
    .slice(0, Math.max(0, arms.length - MIN_ACTIVE))
    .map((a) => ({ armId: a.armId, n: a.total, pBeatsLeader: score[a.armId]! }))
  const dropped = new Set(toArchive.map((a) => a.armId))
  let running = arms.filter((a) => !dropped.has(a.armId))
  let pBest = computePBest(running, rng, samples)

  let flatStreak = rotation !== null && toArchive.length === 0 && isFlat(running, pBest, params.minSamplePerArm) ? rotation.flatStreak + 1 : 0
  if (rotation !== null && flatStreak >= rotation.stagnationDays) {
    const weakest = [...running].sort(
      (a, b) => pBest[a.armId]! - pBest[b.armId]! || posteriorMean(a) - posteriorMean(b) || byArmId(a, b),
    )[0]!
    toArchive.push({ armId: weakest.armId, n: weakest.total, pBest: pBest[weakest.armId]!, reason: 'stagnation' })
    running = running.filter((a) => a.armId !== weakest.armId)
    flatStreak = 0
  }

  const toRestore: ArmRestoreDecision[] = pool
    .filter((a) => (score[a.armId] ?? 0) >= params.restoreThreshold)
    .sort((x, y) => score[y.armId]! - score[x.armId]! || byArmId(x, y))
    .slice(0, Math.max(0, params.slots - running.length))
    .map((a) => ({ armId: a.armId, n: a.total, pBeatsLeader: score[a.armId]! }))
  if (toRestore.length > 0) {
    const back = new Set(toRestore.map((r) => r.armId))
    running = [...running, ...pool.filter((a) => back.has(a.armId)).map((a) => ({ ...a, sinceEntry: 0 }))].sort(byArmId)
    pBest = computePBest(running, rng, samples)
  }

  return {
    weights: running.length === 0 ? {} : capUnproven(running, floorAndNormalize(running, pBest, params.weightFloor), params),
    pBest,
    toArchive,
    toRestore,
    flatStreak,
  }
}
