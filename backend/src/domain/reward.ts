import { z } from 'zod'
import type { responseTypeEnum, sentimentEnum } from '../db/schema'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

const NON_COUNTABLE: ReadonlySet<ResponseType> = new Set<ResponseType>(['bounce', 'auto_reply'])

export function countableReply(args: { responseType: ResponseType }): boolean {
  return !NON_COUNTABLE.has(args.responseType)
}

const rewardWeight = z.number().min(0)
export const rewardWeightsSchema = z.object({
  meetingRequest: rewardWeight.default(1),
  positiveReply: rewardWeight.default(1),
  neutralReply: rewardWeight.default(0.5),
  negativeReply: rewardWeight.default(0),
})
// Sparse twin: an overrides-only reward patch must not freeze untouched weights against future defaults.
export const rewardWeightsPatchSchema = z.object({
  meetingRequest: rewardWeight.optional(),
  positiveReply: rewardWeight.optional(),
  neutralReply: rewardWeight.optional(),
  negativeReply: rewardWeight.optional(),
})
export type RewardWeights = z.infer<typeof rewardWeightsSchema>
export const defaultRewardWeights: RewardWeights = rewardWeightsSchema.parse({})

export function replyReward(
  args: { responseType: ResponseType; sentiment: Sentiment },
  weights: RewardWeights = defaultRewardWeights,
): number {
  if (!countableReply({ responseType: args.responseType })) return 0
  if (args.responseType === 'meeting_request') return weights.meetingRequest
  if (args.responseType === 'rejection') return weights.negativeReply
  switch (args.sentiment) {
    case 'positive':
      return weights.positiveReply
    case 'neutral':
      return weights.neutralReply
    case 'negative':
      return weights.negativeReply
  }
}
