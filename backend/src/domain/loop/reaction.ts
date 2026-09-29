import { z } from 'zod'
import { INQUIRY_OUTCOMES, type InquiryOutcome, type responseTypeEnum, type sentimentEnum } from '../../db/schema'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

export const NON_COUNTABLE_RESPONSE_TYPES: readonly ResponseType[] = ['bounce', 'auto_reply']

export function countableReply(args: { responseType: ResponseType }): boolean {
  return !NON_COUNTABLE_RESPONSE_TYPES.includes(args.responseType)
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

// `lead` is scored by the meeting_request response it writes. `opened` is a
// link scanner more often than a human: half land within five minutes of the
// send, none ever produced a chat turn.
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

// Fixed, unlike the reward weights: the level is what a person reads (the
// positive reaction rate, and the rate with interest), the reward is what the
// loop decides on.
export type ReactionLevel = 'positive' | 'interest' | 'none'
const LEVEL: Record<keyof RewardWeights, ReactionLevel> = {
  meetingRequest: 'positive',
  positiveReply: 'positive',
  inquirySignupClicked: 'positive',
  neutralReply: 'interest',
  inquiryChatEngaged: 'interest',
  negativeReply: 'none',
}
const RANK: Record<ReactionLevel, number> = { none: 0, interest: 1, positive: 2 }

export type Reaction =
  | { kind: 'reply'; responseType: ResponseType; sentiment: Sentiment }
  | { kind: 'inquiry'; outcome: InquiryOutcome }

function weightOf(reaction: Reaction): keyof RewardWeights | null {
  if (reaction.kind === 'inquiry') return INQUIRY_REWARD_WEIGHT[reaction.outcome]
  if (!countableReply(reaction)) return null
  if (reaction.responseType === 'meeting_request') return 'meetingRequest'
  if (reaction.responseType === 'rejection') return 'negativeReply'
  switch (reaction.sentiment) {
    case 'positive':
      return 'positiveReply'
    case 'neutral':
      return 'neutralReply'
    case 'negative':
      return 'negativeReply'
  }
}

export type SendReaction = { reward: number; level: ReactionLevel }

// A send is scored once, by the strongest reaction it drew: a thread of two
// positive replies, or a reply plus a signup, is one positive send.
export function sendReaction(reactions: readonly Reaction[], weights: RewardWeights = defaultRewardWeights): SendReaction {
  let reward = 0
  let level: ReactionLevel = 'none'
  for (const reaction of reactions) {
    const key = weightOf(reaction)
    if (key === null) continue
    reward = Math.max(reward, weights[key])
    if (RANK[LEVEL[key]] > RANK[level]) level = LEVEL[key]
  }
  return { reward, level }
}

// `interested` counts the positive sends too (the rate with interest).
export type ReactionTotals = { rewardSum: number; positive: number; interested: number }

// One row per reaction, so a send's reactions may span rows; its key is the
// bucket the send falls in.
export function reactionTotalsByKey<K>(
  rows: readonly { key: K; outreachLogId: number; reaction: Reaction }[],
  weights: RewardWeights = defaultRewardWeights,
): Map<K, ReactionTotals> {
  const bySend = new Map<number, { key: K; reactions: Reaction[] }>()
  for (const row of rows) {
    const held = bySend.get(row.outreachLogId)
    if (held) held.reactions.push(row.reaction)
    else bySend.set(row.outreachLogId, { key: row.key, reactions: [row.reaction] })
  }
  const byKey = new Map<K, ReactionTotals>()
  for (const { key, reactions } of bySend.values()) {
    const { reward, level } = sendReaction(reactions, weights)
    const totals = byKey.get(key) ?? { rewardSum: 0, positive: 0, interested: 0 }
    totals.rewardSum += reward
    if (level === 'positive') totals.positive++
    if (level !== 'none') totals.interested++
    byKey.set(key, totals)
  }
  return byKey
}
