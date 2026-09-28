import type { LeverDecisionPayload } from '../../db/schema'
import { seededRng, type ArmStat } from './bandit'
import type { LeverConfig } from './config'
import { assessVitals } from './frame'
import {
  applyRotation,
  computeArmWeights,
  computeVariantWeights,
  isFlatTick,
  isStagnant,
  type ArmWeightDecision,
  type StagnationTick,
  type VariantStat,
  type WeightDecision,
} from './options'
import {
  aggregateByCoarse,
  computeAxisLifts,
  computeChannelAffinity,
  overallMeanReward,
  type ChannelFineStat,
  type TargetingLifts,
  type TargetingStats,
} from './allocation'

// Options are the active set only.
export type TickEvidence = {
  variants: VariantStat[]
  strategies: ArmStat[]
  channel: ChannelFineStat[]
  targeting: TargetingStats
  futility: { sends: number; engaged: number }
  // Journaled beside the decision, never decided on.
  registrations: Record<string, number>
  // Newest first, up to stagnationTicks - 1 prior days.
  recentSubjects: LeverDecisionPayload['subject'][]
  unfulfilledRotation: boolean
}

export type TickDecision = {
  variants: WeightDecision
  strategies: ArmWeightDecision
  payload: Required<LeverDecisionPayload>
}

export function decide(evidence: TickEvidence, config: LeverConfig, cycleDate: string, projectId: string): TickDecision {
  const { variants: arms, strategies: strategyArms, targeting: targetingStats } = evidence

  // Own seeded stream, like discovery: the vitals Monte Carlo must not shift
  // the variant/discovery draws a replay would recompute. Deliberately NOT
  // date-keyed: the verdict thresholds the sampled estimate, so a day-varying
  // seed lets identical data flip futile⇄ok at the confidence boundary
  // (measured: 298 zero-reply sends → pDead 0.9503 one day, 0.9498 the next)
  // and the attention alert would flicker without new evidence.
  const vitals = assessVitals(evidence.futility, config, seededRng(`vitals:${projectId}`))

  const rng = seededRng(`${cycleDate}:${projectId}`)
  let decision = computeVariantWeights(arms, config, rng)

  // Stagnation rotation: only when today has no dominance archive (an archive
  // IS movement) and no earlier rotation is still awaiting its fresh angle.
  if (decision.toArchive.length === 0) {
    const todayTick: StagnationTick = {
      variantIds: arms.map((a) => a.variantId),
      flat: isFlatTick(arms, decision.pBest, config.minSamplePerArm),
    }
    if (todayTick.flat) {
      const ticks: StagnationTick[] = [
        todayTick,
        ...evidence.recentSubjects.map((subject) => ({
          variantIds: subject.samples.map((s) => s.variantId),
          flat:
            subject.archived.length === 0 &&
            isFlatTick(subject.samples, subject.pBest, config.minSamplePerArm),
        })),
      ]
      if (isStagnant(ticks, config.stagnationTicks) && !evidence.unfulfilledRotation) {
        decision = applyRotation(arms, decision, config)
      }
    }
  }

  // Its own seeded stream so a discovery decision replays without re-running
  // the variant Monte Carlo.
  const discoveryDecision = computeArmWeights(
    strategyArms,
    {
      minSamplePerArm: config.minSamplePerArm,
      archiveThreshold: config.archiveThreshold,
      weightFloor: config.strategyWeightFloor,
    },
    seededRng(`${cycleDate}:${projectId}:discovery`),
  )

  const channelStats = aggregateByCoarse(evidence.channel)
  const channelAffinity = computeChannelAffinity(channelStats, config)

  // industry partitions all mature sends → its sums are the project baseline.
  const r0 = overallMeanReward(targetingStats.industry)
  const targetingLifts: TargetingLifts = {
    industry: computeAxisLifts(targetingStats.industry, r0, config.priorStrength),
    employeeBand: computeAxisLifts(targetingStats.employeeBand, r0, config.priorStrength),
    country: computeAxisLifts(targetingStats.country, r0, config.priorStrength),
    discoveryStrategy: computeAxisLifts(targetingStats.discoveryStrategy, r0, config.priorStrength),
  }

  return {
    variants: decision,
    strategies: discoveryDecision,
    payload: {
      subject: { weights: decision.weights, pBest: decision.pBest, archived: decision.toArchive, samples: arms },
      channel: { affinity: channelAffinity, samples: channelStats },
      targeting: { lifts: targetingLifts, samples: targetingStats },
      discovery: {
        weights: discoveryDecision.weights,
        pBest: discoveryDecision.pBest,
        archived: discoveryDecision.toArchive.map(({ armId, pBest, n }) => ({ slug: armId, pBest, n })),
        samples: strategyArms.map(({ armId, total, rewardSum }) => ({ slug: armId, total, rewardSum })),
        registrations: evidence.registrations,
      },
      vitals,
      configUsed: config,
    },
  }
}
