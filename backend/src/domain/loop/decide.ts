import type { LeverDecisionPayload } from '../../db/schema'
import { PBEST_SAMPLES, seededRng, type ArmStat } from './bandit'
import type { LeverConfig } from './config'
import { assessVitals } from './frame'
import { decideOptions, type OptionArm, type OptionsDecision } from './options'
import {
  aggregateByCoarse,
  computeAxisLifts,
  computeChannelAffinity,
  overallMeanReward,
  type ChannelFineStat,
  type TargetingLifts,
  type TargetingStats,
} from './allocation'

// `lost` = options the rule archived as lost and nobody has brought back.
export type TickEvidence = {
  variants: {
    // `responses` is journaled beside the decision, never decided on.
    active: Array<OptionArm & { responses: number }>
    lost: ArmStat[]
    // Days in a row the variant set had been flat as of the last tick.
    flatStreak: number
  }
  strategies: { active: OptionArm[]; lost: ArmStat[] }
  channel: ChannelFineStat[]
  targeting: TargetingStats
  futility: { sends: number; engaged: number }
}

export type TickDecision = {
  variants: OptionsDecision
  strategies: OptionsDecision
  payload: Required<LeverDecisionPayload>
}

// `samples` is lowered only by the offline simulation (sim/), for speed.
export function decide(
  evidence: TickEvidence,
  config: LeverConfig,
  cycleDate: string,
  projectId: string,
  samples: number = PBEST_SAMPLES,
): TickDecision {
  const { variants, strategies, targeting: targetingStats } = evidence

  // Own seeded stream, like discovery: the vitals Monte Carlo must not shift
  // the variant/discovery draws a replay would recompute. Deliberately NOT
  // date-keyed: the verdict thresholds the sampled estimate, so a day-varying
  // seed lets identical data flip futile⇄ok at the confidence boundary
  // (measured: 298 zero-reply sends → pDead 0.9503 one day, 0.9498 the next)
  // and the attention alert would flicker without new evidence.
  const vitals = assessVitals(evidence.futility, config, seededRng(`vitals:${projectId}`), samples)

  const rule = {
    minSamplePerArm: config.minSamplePerArm,
    archiveThreshold: config.archiveThreshold,
    // A stored override from before restoreThreshold existed may sit above it;
    // the same score must never both archive and restore.
    restoreThreshold: Math.max(config.restoreThreshold, config.archiveThreshold),
  }
  const decision = decideOptions(
    variants.active,
    variants.lost,
    { ...rule, slots: config.targetActiveArms, weightFloor: config.messageWeightFloor },
    { flatStreak: variants.flatStreak, stagnationDays: config.stagnationTicks },
    seededRng(`${cycleDate}:${projectId}`),
    samples,
  )
  // Its own seeded stream so a discovery decision replays without re-running
  // the variant Monte Carlo. Strategies never rotate: a flat set of sources
  // is not a reason to drop one.
  const discoveryDecision = decideOptions(
    strategies.active,
    strategies.lost,
    { ...rule, slots: config.targetActiveStrategies, weightFloor: config.strategyWeightFloor },
    null,
    seededRng(`${cycleDate}:${projectId}:discovery`),
    samples,
  )

  const channelStats = aggregateByCoarse(evidence.channel)
  const channelAffinity = computeChannelAffinity(channelStats, config)

  // industry partitions all mature sends → its sums are the project baseline.
  const r0 = overallMeanReward(targetingStats.industry)
  const targetingLifts: TargetingLifts = {
    industry: computeAxisLifts(targetingStats.industry, r0, config.priorStrength),
    employeeBand: computeAxisLifts(targetingStats.employeeBand, r0, config.priorStrength),
    country: computeAxisLifts(targetingStats.country, r0, config.priorStrength),
  }

  return {
    variants: decision,
    strategies: discoveryDecision,
    payload: {
      subject: {
        weights: decision.weights,
        pBest: decision.pBest,
        samples: variants.active.map(({ armId, total, responses, rewardSum }) => ({ variantId: armId, total, responses, rewardSum })),
      },
      channel: { affinity: channelAffinity, samples: channelStats },
      targeting: { lifts: targetingLifts, samples: targetingStats },
      discovery: {
        weights: discoveryDecision.weights,
        pBest: discoveryDecision.pBest,
        samples: strategies.active.map(({ armId, total, rewardSum }) => ({ slug: armId, total, rewardSum })),
      },
      vitals,
      configUsed: config,
    },
  }
}
