import { describe, it, expect } from 'vitest'
import {
  countableReply,
  defaultRewardWeights,
  reactionTotalsByKey,
  REWARDED_INQUIRY_OUTCOMES,
  rewardWeightsSchema,
  sendReaction,
  type Reaction,
} from './reaction'

describe('countableReply', () => {
  it('counts human responses', () => {
    expect(countableReply({ responseType: 'reply' })).toBe(true)
    expect(countableReply({ responseType: 'meeting_request' })).toBe(true)
    expect(countableReply({ responseType: 'rejection' })).toBe(true)
  })

  it('excludes machine noise (bounce / auto_reply)', () => {
    expect(countableReply({ responseType: 'bounce' })).toBe(false)
    expect(countableReply({ responseType: 'auto_reply' })).toBe(false)
  })
})

const reply = (responseType: 'reply' | 'meeting_request' | 'rejection' | 'bounce' | 'auto_reply', sentiment: 'positive' | 'neutral' | 'negative'): Reaction => ({
  kind: 'reply',
  responseType,
  sentiment,
})
const inquiry = (outcome: 'opened' | 'inquired' | 'lead' | 'signup_clicked' | 'unsubscribed'): Reaction => ({ kind: 'inquiry', outcome })

describe('sendReaction (default weights)', () => {
  it('gives full reward to a meeting request, regardless of sentiment', () => {
    expect(sendReaction([reply('meeting_request', 'positive')])).toEqual({ reward: 1, level: 'positive' })
    expect(sendReaction([reply('meeting_request', 'negative')])).toEqual({ reward: 1, level: 'positive' })
  })

  it('grades a plain reply by sentiment', () => {
    expect(sendReaction([reply('reply', 'positive')])).toEqual({ reward: 1, level: 'positive' })
    expect(sendReaction([reply('reply', 'neutral')])).toEqual({ reward: 0.5, level: 'interest' })
    expect(sendReaction([reply('reply', 'negative')])).toEqual({ reward: 0, level: 'none' })
  })

  it('gives zero reward to a rejection (a reply, but not a positive outcome)', () => {
    expect(sendReaction([reply('rejection', 'negative')])).toEqual({ reward: 0, level: 'none' })
    expect(sendReaction([reply('rejection', 'neutral')])).toEqual({ reward: 0, level: 'none' })
  })

  it('never rewards machine noise', () => {
    expect(sendReaction([reply('bounce', 'neutral')])).toEqual({ reward: 0, level: 'none' })
    expect(sendReaction([reply('auto_reply', 'positive')])).toEqual({ reward: 0, level: 'none' })
  })

  it('grades acting on the inquiry page like a reply', () => {
    expect(sendReaction([inquiry('inquired')])).toEqual({ reward: 0.5, level: 'interest' })
    expect(sendReaction([inquiry('signup_clicked')])).toEqual({ reward: 1, level: 'positive' })
  })

  it('gives nothing to an outcome that is not a human act, or is scored by its reply', () => {
    expect(sendReaction([inquiry('opened'), inquiry('lead'), inquiry('unsubscribed')])).toEqual({ reward: 0, level: 'none' })
  })

  it('scores a send by its strongest reaction, never the sum', () => {
    expect(sendReaction([reply('reply', 'positive'), reply('reply', 'positive')])).toEqual({ reward: 1, level: 'positive' })
    expect(sendReaction([reply('rejection', 'negative'), inquiry('signup_clicked')])).toEqual({ reward: 1, level: 'positive' })
    expect(sendReaction([inquiry('inquired'), reply('reply', 'neutral')])).toEqual({ reward: 0.5, level: 'interest' })
  })

  it('scores a send with no reaction as nothing', () => {
    expect(sendReaction([])).toEqual({ reward: 0, level: 'none' })
  })
})

describe('sendReaction (custom weights)', () => {
  it('honors a config that weights neutral replies fully and rejections positively', () => {
    const weights = rewardWeightsSchema.parse({ neutralReply: 1, negativeReply: 0.25 })
    expect(sendReaction([reply('reply', 'neutral')], weights).reward).toBe(1)
    expect(sendReaction([reply('rejection', 'negative')], weights).reward).toBe(0.25)
    expect(weights.meetingRequest).toBe(defaultRewardWeights.meetingRequest)
  })

  it('keeps the level fixed whatever the weights', () => {
    const weights = rewardWeightsSchema.parse({ neutralReply: 1, negativeReply: 0.25 })
    expect(sendReaction([reply('reply', 'neutral')], weights).level).toBe('interest')
    expect(sendReaction([reply('rejection', 'negative')], weights).level).toBe('none')
  })

  it('takes the higher weight when a weaker level is weighted above a stronger one', () => {
    const weights = rewardWeightsSchema.parse({ inquiryChatEngaged: 1, positiveReply: 0.5 })
    expect(sendReaction([reply('reply', 'positive'), inquiry('inquired')], weights)).toEqual({ reward: 1, level: 'positive' })
  })

  it('rejects negative weights', () => {
    expect(() => rewardWeightsSchema.parse({ positiveReply: -1 })).toThrow()
  })
})

describe('REWARDED_INQUIRY_OUTCOMES', () => {
  it('names exactly the outcomes a query has to fetch', () => {
    expect([...REWARDED_INQUIRY_OUTCOMES]).toEqual(['inquired', 'signup_clicked'])
  })
})

describe('reactionTotalsByKey', () => {
  it('scores each send once across its rows', () => {
    const byKey = reactionTotalsByKey([
      { key: 'yc-hn', outreachLogId: 1, reaction: reply('reply', 'positive') },
      { key: 'yc-hn', outreachLogId: 1, reaction: reply('reply', 'positive') },
      { key: 'yc-hn', outreachLogId: 1, reaction: inquiry('inquired') },
    ])
    expect(byKey.get('yc-hn')).toEqual({ rewardSum: 1, positive: 1, interested: 1 })
  })

  it('sums across sends and splits by key', () => {
    const byKey = reactionTotalsByKey([
      { key: 'yc-hn', outreachLogId: 1, reaction: inquiry('inquired') },
      { key: 'yc-hn', outreachLogId: 2, reaction: reply('reply', 'positive') },
      { key: 'yc-hn', outreachLogId: 3, reaction: reply('rejection', 'negative') },
      { key: null, outreachLogId: 4, reaction: inquiry('signup_clicked') },
    ])
    expect(byKey.get('yc-hn')).toEqual({ rewardSum: 1.5, positive: 1, interested: 2 })
    expect(byKey.get(null)).toEqual({ rewardSum: 1, positive: 1, interested: 1 })
  })
})
