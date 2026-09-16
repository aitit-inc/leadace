import { z } from 'zod'
import { INQUIRY_OUTCOMES, type InquiryOutcome, type responseTypeEnum, type sentimentEnum } from '../db/schema'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

const NON_COUNTABLE: ReadonlySet<ResponseType> = new Set<ResponseType>(['bounce', 'auto_reply'])

export function countableReply(args: { responseType: ResponseType }): boolean {
  return !NON_COUNTABLE.has(args.responseType)
}

// Cap 1: rewardSum is fractional successes over sends — a weight above 1
// breaks the targeting posterior and the Beta update outright.
const rewardWeight = z.number().min(0).max(1)
export const rewardWeightsSchema = z.object({
  meetingRequest: rewardWeight.default(1),
  positiveReply: rewardWeight.default(1),
  neutralReply: rewardWeight.default(0.5),
  negativeReply: rewardWeight.default(0),
  inquiryChatEngaged: rewardWeight.default(0.5),
  inquirySignupClicked: rewardWeight.default(1),
})
// Sparse twin: an overrides-only reward patch must not freeze untouched weights against future defaults.
export const rewardWeightsPatchSchema = z.object({
  meetingRequest: rewardWeight.optional(),
  positiveReply: rewardWeight.optional(),
  neutralReply: rewardWeight.optional(),
  negativeReply: rewardWeight.optional(),
  inquiryChatEngaged: rewardWeight.optional(),
  inquirySignupClicked: rewardWeight.optional(),
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

// `lead` already writes a meeting_request response — weighting it here would
// count one send twice. `opened` is a link scanner more often than a human:
// half land within five minutes of the send, none ever produced a chat turn.
const INQUIRY_REWARD_WEIGHT: Record<InquiryOutcome, keyof RewardWeights | null> = {
  opened: null,
  inquired: 'inquiryChatEngaged',
  lead: null,
  signup_clicked: 'inquirySignupClicked',
  unsubscribed: null,
}

export const REWARDED_INQUIRY_OUTCOMES: readonly InquiryOutcome[] = INQUIRY_OUTCOMES.filter(
  (outcome) => INQUIRY_REWARD_WEIGHT[outcome] !== null,
)

export function inquiryReward(
  args: { outcome: InquiryOutcome },
  weights: RewardWeights = defaultRewardWeights,
): number {
  const key = INQUIRY_REWARD_WEIGHT[args.outcome]
  return key === null ? 0 : weights[key]
}

// Summing a send's sessions would let one send outscore a meeting request.
export function inquiryRewardByKey(
  rows: readonly { key: string; outreachLogId: number; outcome: InquiryOutcome }[],
  weights: RewardWeights = defaultRewardWeights,
): Map<string, number> {
  const bySend = new Map<number, { key: string; reward: number }>()
  for (const row of rows) {
    const reward = inquiryReward({ outcome: row.outcome }, weights)
    const held = bySend.get(row.outreachLogId)
    if (held === undefined || reward > held.reward) bySend.set(row.outreachLogId, { key: row.key, reward })
  }
  const byKey = new Map<string, number>()
  for (const { key, reward } of bySend.values()) byKey.set(key, (byKey.get(key) ?? 0) + reward)
  return byKey
}
