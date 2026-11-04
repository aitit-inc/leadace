import { z } from 'zod'
import { INQUIRY_OUTCOMES, type InquiryOutcome, type RejectionPrimaryReason, type responseTypeEnum, type sentimentEnum } from '../../db/schema'

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
  // A no is still the market answering.
  negativeReply: rewardWeight.default(0.2),
  optOut: rewardWeight.default(0),
  inquiryChatEngaged: rewardWeight.default(0.5),
  inquirySignupClicked: rewardWeight.default(1),
})
// Sparse twin: an overrides-only reward patch must not freeze untouched weights against future defaults.
export const rewardWeightsPatchSchema = z.object({
  meetingRequest: rewardWeight.optional(),
  positiveReply: rewardWeight.optional(),
  neutralReply: rewardWeight.optional(),
  negativeReply: rewardWeight.optional(),
  optOut: rewardWeight.optional(),
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
  unsubscribed: 'optOut',
}

// The inquiry-page acts the reward and sendOutcome read, so the ones a query
// has to fetch. An opt-out is one even with no reply beside it, as when the
// person gives no reason.
export const SCORED_INQUIRY_OUTCOMES: readonly InquiryOutcome[] = INQUIRY_OUTCOMES.filter(
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
  optOut: 'none',
}
const RANK: Record<ReactionLevel, number> = { none: 0, interest: 1, positive: 2 }

// `reason` is the stated reason of a rejection (rejection_feedback), else null.
export type Reaction =
  | { kind: 'reply'; responseType: ResponseType; sentiment: Sentiment; reason: RejectionPrimaryReason | null }
  | { kind: 'inquiry'; outcome: InquiryOutcome }

function weightOf(reaction: Reaction): keyof RewardWeights | null {
  if (reaction.kind === 'inquiry') return INQUIRY_REWARD_WEIGHT[reaction.outcome]
  if (!countableReply(reaction)) return null
  if (reaction.responseType === 'meeting_request') return 'meetingRequest'
  if (reaction.responseType === 'rejection' || reaction.sentiment === 'negative') {
    return reaction.reason === 'unsubscribe_request' ? 'optOut' : 'negativeReply'
  }
  switch (reaction.sentiment) {
    case 'positive':
      return 'positiveReply'
    case 'neutral':
      return 'neutralReply'
  }
}

export type SendReaction = { reward: number; level: ReactionLevel }

// A send is scored once, by the strongest reaction it drew: a thread of two
// positive replies, or a reply plus a signup, is one positive send. A no that
// came with an opt-out scores as the opt-out.
export function sendReaction(reactions: readonly Reaction[], weights: RewardWeights = defaultRewardWeights): SendReaction {
  const optedOut = reactions.some((reaction) => weightOf(reaction) === 'optOut')
  let reward = 0
  let level: ReactionLevel = 'none'
  for (const reaction of reactions) {
    const key = weightOf(reaction)
    if (key === null || (optedOut && key === 'negativeReply')) continue
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

// What a send's reactions say beyond the reward: a no's stated reason, and a
// bounce (the address failed, not the message).
export type SendOutcome =
  | { kind: 'positive' | 'interest' | 'bounced' | 'silent' }
  | { kind: 'declined'; reason: RejectionPrimaryReason | null }

// undefined when the reaction is not a no.
function declineReason(reaction: Reaction): RejectionPrimaryReason | null | undefined {
  if (reaction.kind === 'inquiry') return reaction.outcome === 'unsubscribed' ? 'unsubscribe_request' : undefined
  const key = weightOf(reaction)
  return key === 'negativeReply' || key === 'optOut' ? reaction.reason : undefined
}

// `reactions` in the order they arrived: a later stated reason wins, and
// 'other' only when no specific one was given. A person's reaction outranks a
// bounce: the mail reached someone.
export function sendOutcome(reactions: readonly Reaction[]): SendOutcome {
  const { level } = sendReaction(reactions)
  if (level !== 'none') return { kind: level }
  const declines = reactions.map(declineReason).filter((reason) => reason !== undefined)
  if (declines.length > 0) {
    const stated = declines.filter((reason) => reason !== null)
    return { kind: 'declined', reason: stated.findLast((reason) => reason !== 'other') ?? stated.at(-1) ?? null }
  }
  return reactions.some((r) => r.kind === 'reply' && r.responseType === 'bounce') ? { kind: 'bounced' } : { kind: 'silent' }
}
