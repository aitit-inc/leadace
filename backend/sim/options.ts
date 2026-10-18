// Options experiment (#793): the middle and inner layers — which options run,
// which are dropped or brought back, and how sends are split among them — as
// the production decide() rules them. Every policy sees the same market: the
// i-th option created in a run has the same true rate, and its n-th send draws
// the same outcome (common random numbers), so differences come from the config.
//
// Mirrors that hold while these results are read:
// - An option's evidence is every send so far, counted as production counts
//   it (delay.ts; the pre-#906 14-day maturity is the 'mature' model).
// - The LLM that writes new options is a draw from the market distribution,
//   refilling the active set to the target count right after the tick (decide
//   → propose); the rule restores lost options into free slots first.
// - Sends are drawn per send from the stored weights; an option added after
//   the tick enters at the floor (prepareDrawDistribution / floorRescuedWeights).
// - Strategies are modeled like messages minus the stagnation rotation: their
//   sends follow the batch plan, which is the same weights.

import { seededRng, weightedDraw, type ArmStat } from '../src/domain/loop/bandit'
import { decide, type TickEvidence } from '../src/domain/loop/decide'
import type { OptionArm } from '../src/domain/loop/options'
import { floorRescuedWeights } from '../src/domain/loop/allocation'
import type { LeverConfig } from '../src/domain/loop/config'
import {
  evidenceLog,
  sampleReplyDelay,
  settleAgeFor,
  productionEvidence,
  type EvidenceLog,
  type EvidenceModel,
  type LogStat,
  type SimSend,
} from './delay'
import { stats } from './metrics'

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

type OptionState = 'active' | 'lost' | 'rotated'

type SimOption = {
  id: string
  rate: number
  state: OptionState
  // The evidence as of today's tick.
  stat: LogStat
  log: EvidenceLog
  createdDay: number
  // First tick on which the rule could judge it (proven and out of its grace).
  judgedDay: number | null
  restoredOnce: boolean
  send: (day: number) => SimSend
}

// How reactions reach the evidence.
export type FeedbackModel = {
  evidence: EvidenceModel
  // The market's reply delay is this multiple of the measured one (delay.ts).
  trueDelayScale: number
  // Human replies that carry no reward (rejections, neutral replies).
  nonPositiveReplyRate: number
}

export const productionFeedback: FeedbackModel = {
  evidence: productionEvidence,
  trueDelayScale: 1,
  nonPositiveReplyRate: 0,
}

// Days after an option is created at which its evidence is snapshotted.
export const BIAS_DAYS = [3, 7, 14, 30] as const
type BiasDay = (typeof BIAS_DAYS)[number]
type BiasSums = { options: number; n: number; s: number; expectedS: number; posteriorMean: number; rate: number }
const emptyBias = (): BiasSums => ({ options: 0, n: 0, s: 0, expectedS: 0, posteriorMean: 0, rate: 0 })

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
  // Days from creation to the first tick that could judge it, for options
  // created at least 60 days before the end; null = never judged.
  judgedAfter: (number | null)[]
  bias: Record<BiasDay, BiasSums>
}

const armOf = (o: SimOption): ArmStat => ({ armId: o.id, total: o.stat.total, rewardSum: o.stat.rewardSum })
const activeArm = (o: SimOption): OptionArm => ({ ...armOf(o), sinceEntry: o.stat.sinceEntry })
const posteriorMean = (o: SimOption): number => (1 + o.stat.rewardSum) / (2 + o.stat.total)

export function runOptions(
  scenario: OptionsScenario,
  seed: number,
  config: LeverConfig,
  samples: number,
  feedback: FeedbackModel = productionFeedback,
): OptionsRun {
  const key = `${scenario.name}:${seed}`
  const marketRng = seededRng(`market:${key}`)
  const allocRng = seededRng(`alloc:${key}`)
  const floor = scenario.layer === 'message' ? config.messageWeightFloor : config.strategyWeightFloor
  const target = scenario.layer === 'message' ? config.targetActiveArms : config.targetActiveStrategies

  const settleAge = settleAgeFor(feedback.evidence, feedback.trueDelayScale)
  const options: SimOption[] = []
  const byId = new Map<string, SimOption>()
  const create = (day: number): void => {
    const index = options.length
    // No draw when the share is 0, so markets without breakthroughs keep their stream.
    const breakthrough = scenario.breakthroughShare > 0 && marketRng() < scenario.breakthroughShare
    const rate = scenario.baseRate * (breakthrough ? 2 : 1 - scenario.spread + 2 * scenario.spread * marketRng())
    const rng = seededRng(`outcome:${key}:${index}`)
    // Its own stream, so the n-th outcome matches the runs under any delay model.
    const delayRng = seededRng(`delay:${key}:${index}`)
    const option: SimOption = {
      id: `o${String(index).padStart(3, '0')}`,
      rate,
      state: 'active',
      stat: { total: 0, rewardSum: 0, sinceEntry: 0 },
      log: evidenceLog(feedback.evidence, settleAge),
      createdDay: day,
      judgedDay: null,
      restoredOnce: false,
      send: (sentDay) => {
        const u = rng()
        const delay = feedback.trueDelayScale * sampleReplyDelay(delayRng())
        return {
          day: sentDay,
          reward: u < rate ? 1 : 0,
          replyAt: u < rate + feedback.nonPositiveReplyRate ? sentDay + delay : null,
        }
      },
    }
    options.push(option)
    byId.set(option.id, option)
  }
  for (let i = 0; i < target; i++) create(0)

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
    judgedAfter: [],
    bias: { 3: emptyBias(), 7: emptyBias(), 14: emptyBias(), 30: emptyBias() },
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
  let flatStreak = 0

  for (let day = 0; day < scenario.horizonDays; day++) {
    for (const o of options) {
      o.stat = o.log.stat(day)
      const bias = run.bias[(day - o.createdDay) as BiasDay] as BiasSums | undefined
      if (bias !== undefined) {
        bias.options += 1
        bias.n += o.stat.total
        bias.s += o.stat.rewardSum
        bias.expectedS += o.rate * o.stat.total
        bias.posteriorMean += posteriorMean(o)
        bias.rate += o.rate
      }
      const judgeable = o.stat.total >= config.minSamplePerArm && o.stat.sinceEntry >= config.minSamplePerArm
      if (o.judgedDay === null && o.state === 'active' && judgeable) o.judgedDay = day
    }

    const matureActive = active().filter((o) => o.stat.total >= config.minSamplePerArm)
    if (matureActive.length >= 2) {
      const leader = matureActive.reduce((a, b) => (posteriorMean(b) > posteriorMean(a) ? b : a))
      run.leaderDays += 1
      if (leader.rate === Math.max(...matureActive.map((o) => o.rate))) run.leaderRightDays += 1
    }

    const lost = options.filter((o) => o.state === 'lost').map(armOf)
    const evidence: TickEvidence = {
      variants: scenario.layer === 'message'
        ? { active: active().map((o) => ({ ...activeArm(o), responses: o.stat.rewardSum })), lost, flatStreak }
        : { active: [], lost: [], flatStreak: 0 },
      strategies: scenario.layer === 'strategy' ? { active: active().map(activeArm), lost } : { active: [], lost: [] },
      channel: [],
      targeting: { industry: [], employeeBand: [], country: [] },
      futility: { sends: 0, engaged: 0 },
      frame: { trials: 0, positive: 0 },
    }
    const decision = decide(evidence, config, String(day), key, samples)
    const layer = scenario.layer === 'message' ? decision.variants : decision.strategies
    archive(layer.toArchive.filter((a) => !('reason' in a)).map((a) => a.armId), 'lost')
    archive(layer.toArchive.filter((a) => 'reason' in a).map((a) => a.armId), 'rotated')
    for (const { armId } of layer.toRestore) {
      const o = byId.get(armId)!
      o.state = 'active'
      o.log.enter(day)
      o.restoredOnce = true
      run.restores += 1
    }
    weights = layer.weights
    flatStreak = layer.flatStreak
    while (active().length < target) {
      create(day)
      run.created += 1
    }

    const running = active()
    const ids = running.map((o) => o.id)
    const stored = floorRescuedWeights(ids, weights, floor)
    const sum = ids.reduce((acc, id) => acc + stored[id]!, 0)
    const draw = sum > 0 ? stored : Object.fromEntries(ids.map((id) => [id, 1]))
    const bestAvailable = Math.max(...options.map((o) => o.rate))
    for (let i = 0; i < scenario.sendsPerDay; i++) {
      const option = byId.get(weightedDraw(draw, allocRng))!
      if (option.stat.total < config.minSamplePerArm) run.immatureSends += 1
      option.log.add(option.send(day))
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
  run.judgedAfter = options
    .filter((o) => o.createdDay < scenario.horizonDays - 60)
    .map((o) => (o.judgedDay === null ? null : o.judgedDay - o.createdDay))
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

// Entry to first judgment, and the evidence early in an option's life: n is
// what the rule counts; sBias = Σ arrived rewards / Σ (true rate × n) − 1, the
// estimator's systematic error; pmRatio = mean posterior mean / mean true rate.
export function aggregateFeedback(runs: OptionsRun[]): Record<string, number | null> {
  const judgedAfter = runs.flatMap((r) => r.judgedAfter)
  const judged = stats(judgedAfter)
  const out: Record<string, number | null> = {
    judgedDaysP50: judged.p50,
    judgedDaysP90: judged.p90,
    neverJudged: judgedAfter.filter((d) => d === null).length / judgedAfter.length,
  }
  for (const day of BIAS_DAYS) {
    const b = emptyBias()
    for (const r of runs) {
      const x = r.bias[day]
      b.options += x.options
      b.n += x.n
      b.s += x.s
      b.expectedS += x.expectedS
      b.posteriorMean += x.posteriorMean
      b.rate += x.rate
    }
    out[`n@${day}`] = b.options > 0 ? b.n / b.options : null
    out[`sBias@${day}`] = b.expectedS > 0 ? b.s / b.expectedS - 1 : null
    out[`pmRatio@${day}`] = b.rate > 0 ? b.posteriorMean / b.rate : null
  }
  return out
}
