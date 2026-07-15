import { z } from 'zod'
import { rewardWeightsSchema, rewardWeightsPatchSchema, defaultRewardWeights } from './reward'

const minSamplePerArm = z.number().int().min(1)
const rewardWindowDays = z.number().int().min(1)
const rewardLookbackDays = z.number().int().min(1)
const priorStrength = z.number().min(1)
const explorationShare = z.number().min(0).max(1)
const archiveThreshold = z.number().min(0).max(1)
const targetActiveArms = z.number().int().min(2)
const maxActiveArms = z.number().int().min(2)
const messageWeightFloor = z.number().min(0).max(1)
const stagnationTicks = z.number().int().min(2)

// R5 safety device: defaults make every lever behave like today until enough data accrues.
export const leverConfigSchema = z.object({
  // Archive gate for the message bandit (P(best) < threshold on n >= minSamplePerArm).
  minSamplePerArm: minSamplePerArm.default(30),
  rewardWindowDays: rewardWindowDays.default(14),
  // Forgetting window (opt-in). When set, the tick weighs only the most recent
  // `rewardLookbackDays` days of reply-mature sends: the band is
  // [now - rewardWindowDays - rewardLookbackDays, now - rewardWindowDays). Stacking
  // past the maturation cutoff keeps the band non-empty for any value >= 1, so no
  // cross-field invariant can be violated. Unset = all mature history.
  rewardLookbackDays: rewardLookbackDays.optional(),
  reward: rewardWeightsSchema.default(defaultRewardWeights),
  // Shrinkage prior (pseudo-sends at the project mean) for the targeting lifts.
  priorStrength: priorStrength.default(25),
  // Random share of each outbound batch. 0 would make the ordering a de-facto
  // selection gate: low-scored buckets never send again and early flukes self-seal.
  explorationShare: explorationShare.default(0.2),
  archiveThreshold: archiveThreshold.default(0.05),
  // Below target → needsReplenishment (evaluate supplies one fresh angle);
  // above max → upsert of a new active variant is refused.
  targetActiveArms: targetActiveArms.default(3),
  maxActiveArms: maxActiveArms.default(4),
  messageWeightFloor: messageWeightFloor.default(0.1),
  // Flat-tick streak length (all arms mature, max P(best) < the ceiling) that
  // triggers the stagnation rotation.
  stagnationTicks: stagnationTicks.default(7),
})
export type LeverConfig = z.infer<typeof leverConfigSchema>
export const defaultLeverConfig: LeverConfig = leverConfigSchema.parse({})

// Overrides-only storage shape (the jsonb $type): unset fields are filled at read, so default changes need no backfill.
export const leverConfigPatchSchema = z.object({
  minSamplePerArm: minSamplePerArm.optional(),
  rewardWindowDays: rewardWindowDays.optional(),
  rewardLookbackDays: rewardLookbackDays.optional(),
  reward: rewardWeightsPatchSchema.optional(),
  priorStrength: priorStrength.optional(),
  explorationShare: explorationShare.optional(),
  archiveThreshold: archiveThreshold.optional(),
  targetActiveArms: targetActiveArms.optional(),
  maxActiveArms: maxActiveArms.optional(),
  messageWeightFloor: messageWeightFloor.optional(),
  stagnationTicks: stagnationTicks.optional(),
})
export type LeverConfigPatch = z.infer<typeof leverConfigPatchSchema>
