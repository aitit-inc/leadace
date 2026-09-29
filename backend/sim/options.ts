// Options experiment (#793): the middle and inner layers — which options run,
// which are dropped or brought back, and how sends are split among them.
// `current` calls the production decide(); `proposed` runs the candidate
// rules in proposed.ts. Both see the same market: the i-th option created in a
// run has the same true rate under either policy, and its n-th send draws the
// same outcome (common random numbers), so differences come from the rules.
//
// Mirrors that hold while these results are read:
// - An option's evidence is its sends matured rewardWindowDays after sending.
// - The LLM that writes new options is a draw from the market distribution,
//   refilling the active set right after the tick (design v2 order: decide →
//   propose). Current rules refill to the target count; proposed rules to
//   `slots`, restoring lost options first.
// - Sends are drawn per send from the stored weights; an option added after
//   the tick enters at the floor (prepareDrawDistribution / floorRescuedWeights).
// - Strategies are modeled like messages minus the stagnation rotation: their
//   sends follow the batch plan, which is the same weights.

import { seededRng, weightedDraw, type ArmStat } from '../src/domain/loop/bandit'
import { decide, type TickEvidence } from '../src/domain/loop/decide'
import { applyRotation, isFlatTick, isStagnant, type StagnationTick, type VariantStat } from '../src/domain/loop/options'
import { floorRescuedWeights } from '../src/domain/loop/allocation'
import type { LeverConfig } from '../src/domain/loop/config'
import type { LeverDecisionPayload } from '../src/db/schema'
import { allocate, judgeLost, pickRestores, type ProposedParams } from './proposed'

export type OptionsScenario = {
  name: string
  layer: 'message' | 'strategy'
  sendsPerDay: number
  // Mean positive rate of an option in this frame.
  baseRate: number
  // An option's true rate is baseRate × U(1 − spread, 1 + spread); 1/3 keeps
  // any two options within 2× of each other.
  spread: number
  // Share of new options that land at 2× the base rate — an angle that really
  // works, which a uniform spread never produces.
  breakthroughShare: number
  horizonDays: number
}

export type ProposedRules = Pick<ProposedParams, 'compare' | 'restoreAt' | 'restoreRotated' | 'slots' | 'minActive' | 'capImmature'>

export type OptionsPolicy =
  | { kind: 'current'; config: LeverConfig }
  | ({ kind: 'proposed'; config: LeverConfig } & ProposedRules)

type OptionState = 'active' | 'lost' | 'rotated'

type SimOption = {
  id: string
  rate: number
  state: OptionState
  total: number
  reward: number
  restoredOnce: boolean
  outcome: () => number
}

export type OptionsRun = {
  archives: number
  // Stagnation rotations, counted in archives too.
  rotations: number
  wrongArchives: number
  // Wrong archives that were stagnation rotations.
  wrongRotations: number
  // Days with >= 2 mature active options, and those on which the option with
  // the highest posterior mean really was the best of them.
  leaderDays: number
  leaderRightDays: number
  restores: number
  // Re-archives of an option that had been restored.
  flips: number
  created: number
  sends: number
  expectedReward: number
  // Σ over sends of the best true rate among options that existed that day.
  bestAvailableReward: number
  immatureSends: number
  bestEverArchivedAtEnd: boolean
  // How the best option ever created left, when it is gone at the end.
  bestEverGoneBy: 'lost' | 'rotated' | null
  // (best rate ever − best active rate at the end) / best rate ever.
  endGap: number
}

const armOf = (o: SimOption): ArmStat => ({ armId: o.id, total: o.total, rewardSum: o.reward })
const variantOf = (o: SimOption): VariantStat => ({ variantId: o.id, total: o.total, responses: o.reward, rewardSum: o.reward })

function proposedParams(policy: Extract<OptionsPolicy, { kind: 'proposed' }>, layer: OptionsScenario['layer']): ProposedParams {
  const { config } = policy
  return {
    minSample: config.minSamplePerArm,
    lostBelow: config.archiveThreshold,
    restoreAt: policy.restoreAt,
    restoreRotated: policy.restoreRotated,
    slots: policy.slots,
    compare: policy.compare,
    minActive: policy.minActive,
    weightFloor: layer === 'message' ? config.messageWeightFloor : config.strategyWeightFloor,
    capImmature: policy.capImmature,
  }
}

export function runOptions(scenario: OptionsScenario, seed: number, policy: OptionsPolicy, samples: number): OptionsRun {
  const { config } = policy
  const key = `${scenario.name}:${seed}`
  const marketRng = seededRng(`market:${key}`)
  const allocRng = seededRng(`alloc:${key}`)
  const floor = scenario.layer === 'message' ? config.messageWeightFloor : config.strategyWeightFloor
  const target =
    policy.kind === 'proposed'
      ? policy.slots
      : scenario.layer === 'message'
        ? config.targetActiveArms
        : config.targetActiveStrategies

  const options: SimOption[] = []
  const byId = new Map<string, SimOption>()
  const create = (): void => {
    const index = options.length
    // No draw when the share is 0, so markets without breakthroughs keep their stream.
    const breakthrough = scenario.breakthroughShare > 0 && marketRng() < scenario.breakthroughShare
    const rate = scenario.baseRate * (breakthrough ? 2 : 1 - scenario.spread + 2 * scenario.spread * marketRng())
    const rng = seededRng(`outcome:${key}:${index}`)
    const option: SimOption = {
      id: `o${String(index).padStart(3, '0')}`,
      rate,
      state: 'active',
      total: 0,
      reward: 0,
      restoredOnce: false,
      outcome: () => (rng() < rate ? 1 : 0),
    }
    options.push(option)
    byId.set(option.id, option)
  }
  for (let i = 0; i < target; i++) create()

  const run: OptionsRun = {
    archives: 0,
    rotations: 0,
    wrongArchives: 0,
    wrongRotations: 0,
    leaderDays: 0,
    leaderRightDays: 0,
    restores: 0,
    flips: 0,
    created: 0,
    sends: 0,
    expectedReward: 0,
    bestAvailableReward: 0,
    immatureSends: 0,
    bestEverArchivedAtEnd: false,
    bestEverGoneBy: null,
    endGap: 0,
  }
  const active = (): SimOption[] => options.filter((o) => o.state === 'active')

  const archive = (ids: string[], state: 'lost' | 'rotated'): void => {
    const before = active()
    for (const id of ids) {
      const o = byId.get(id)!
      const bestOther = Math.max(...before.filter((b) => b.id !== id).map((b) => b.rate))
      if (o.rate > bestOther) {
        run.wrongArchives += 1
        if (state === 'rotated') run.wrongRotations += 1
      }
      if (o.restoredOnce) run.flips += 1
      o.state = state
      run.archives += 1
      if (state === 'rotated') run.rotations += 1
    }
  }

  let weights: Record<string, number> = {}
  const recentSubjects: LeverDecisionPayload['subject'][] = []
  const stagnation: StagnationTick[] = []
  const pending: { day: number; option: SimOption; reward: number }[] = []

  for (let day = 0; day < scenario.horizonDays; day++) {
    while (pending.length > 0 && day - pending[0]!.day >= config.rewardWindowDays) {
      const { option, reward } = pending.shift()!
      option.total += 1
      option.reward += reward
    }

    const matureActive = active().filter((o) => o.total >= config.minSamplePerArm)
    if (matureActive.length >= 2) {
      const mean = (o: SimOption): number => (1 + o.reward) / (2 + o.total)
      const leader = matureActive.reduce((a, b) => (mean(b) > mean(a) ? b : a))
      run.leaderDays += 1
      if (leader.rate === Math.max(...matureActive.map((o) => o.rate))) run.leaderRightDays += 1
    }

    if (policy.kind === 'current') {
      const running = active()
      const evidence: TickEvidence = {
        variants: scenario.layer === 'message' ? running.map(variantOf) : [],
        strategies: scenario.layer === 'strategy' ? running.map(armOf) : [],
        channel: [],
        targeting: { industry: [], employeeBand: [], country: [], discoveryStrategy: [] },
        futility: { sends: 0, engaged: 0 },
        registrations: {},
        recentSubjects: [...recentSubjects],
        unfulfilledRotation: false,
      }
      const decision = decide(evidence, config, String(day), key, samples)
      if (scenario.layer === 'message') {
        const rotated = decision.variants.toArchive.filter((a) => a.reason === 'stagnation').map((a) => a.variantId)
        const lost = decision.variants.toArchive.filter((a) => a.reason !== 'stagnation').map((a) => a.variantId)
        archive(lost, 'lost')
        archive(rotated, 'rotated')
        weights = decision.variants.weights
        recentSubjects.unshift(decision.payload.subject)
        recentSubjects.length = Math.min(recentSubjects.length, config.stagnationTicks - 1)
      } else {
        archive(decision.strategies.toArchive.map((a) => a.armId), 'lost')
        weights = decision.strategies.weights
      }
      while (active().length < target) {
        create()
        run.created += 1
      }
    } else {
      const params = proposedParams(policy, scenario.layer)
      const rng = seededRng(`${day}:${key}:proposed`)
      const lostPool = options.filter((o) => o.state === 'lost' || (params.restoreRotated && o.state === 'rotated'))
      const judged = judgeLost(active().map(armOf), lostPool.map(armOf), params, rng, samples)
      archive(judged.lost, 'lost')

      if (scenario.layer === 'message' && judged.lost.length === 0) {
        const { pBest } = allocate(active().map(armOf), params, rng, samples)
        const running = active().map(variantOf)
        stagnation.unshift({ variantIds: running.map((v) => v.variantId), flat: isFlatTick(running, pBest, params.minSample) })
        stagnation.length = Math.min(stagnation.length, config.stagnationTicks)
        if (isStagnant(stagnation, config.stagnationTicks)) {
          const rotation = applyRotation(running, { weights: {}, pBest, toArchive: [] }, config)
          archive(rotation.toArchive.map((a) => a.variantId), 'rotated')
          stagnation.length = 0
        }
      } else {
        stagnation.length = 0
      }

      const free = params.slots - active().length
      for (const id of pickRestores(lostPool.map(armOf), judged.pMature, params, free)) {
        const o = byId.get(id)!
        o.state = 'active'
        o.restoredOnce = true
        run.restores += 1
      }
      weights = allocate(active().map(armOf), params, rng, samples).weights
      while (active().length < params.slots) {
        create()
        run.created += 1
      }
    }

    const running = active()
    const ids = running.map((o) => o.id)
    const stored = floorRescuedWeights(ids, weights, floor)
    const sum = ids.reduce((acc, id) => acc + stored[id]!, 0)
    const draw = sum > 0 ? stored : Object.fromEntries(ids.map((id) => [id, 1]))
    const bestAvailable = Math.max(...options.map((o) => o.rate))
    for (let i = 0; i < scenario.sendsPerDay; i++) {
      const option = byId.get(weightedDraw(draw, allocRng))!
      const reward = option.outcome()
      if (option.total < config.minSamplePerArm) run.immatureSends += 1
      pending.push({ day, option, reward })
      run.sends += 1
      run.expectedReward += option.rate
      run.bestAvailableReward += bestAvailable
    }
  }

  // Rate, not identity: equally good options (every one at 0%) tie for best.
  const bestEverRate = Math.max(...options.map((o) => o.rate))
  const bestActiveRate = Math.max(...active().map((o) => o.rate))
  run.bestEverArchivedAtEnd = bestActiveRate < bestEverRate
  if (run.bestEverArchivedAtEnd) {
    const gone = options.find((o) => o.rate === bestEverRate)!.state
    run.bestEverGoneBy = gone === 'active' ? null : gone
  }
  run.endGap = bestEverRate > 0 ? (bestEverRate - bestActiveRate) / bestEverRate : 0
  return run
}

// Pooled over seeds, per 360 days where it is a count.
export function aggregateOptions(runs: OptionsRun[], scenario: OptionsScenario): Record<string, number | null> {
  const sum = (f: (r: OptionsRun) => number): number => runs.reduce((acc, r) => acc + f(r), 0)
  const perYear = (f: (r: OptionsRun) => number): number => (sum(f) / runs.length) * (360 / scenario.horizonDays)
  const sends = sum((r) => r.sends)
  const archives = sum((r) => r.archives)
  const bestAvailable = sum((r) => r.bestAvailableReward)
  return {
    runs: runs.length,
    rateLift: scenario.baseRate > 0 ? sum((r) => r.expectedReward) / (sends * scenario.baseRate) : null,
    capture: bestAvailable > 0 ? sum((r) => r.expectedReward) / bestAvailable : null,
    wrongArchiveShare: archives > 0 ? sum((r) => r.wrongArchives) / archives : null,
    wrongPerYear: perYear((r) => r.wrongArchives),
    wrongRotationsPerYear: perYear((r) => r.wrongRotations),
    leaderRight: sum((r) => r.leaderDays) > 0 ? sum((r) => r.leaderRightDays) / sum((r) => r.leaderDays) : null,
    archivesPerYear: perYear((r) => r.archives),
    rotationsPerYear: perYear((r) => r.rotations),
    restoresPerYear: perYear((r) => r.restores),
    flipsPerYear: perYear((r) => r.flips),
    createdPerYear: perYear((r) => r.created),
    immatureShare: sum((r) => r.immatureSends) / sends,
    bestArchivedAtEnd: runs.filter((r) => r.bestEverArchivedAtEnd).length / runs.length,
    bestGoneByRotation: runs.filter((r) => r.bestEverGoneBy === 'rotated').length / runs.length,
    endGapMean: sum((r) => r.endGap) / runs.length,
  }
}
