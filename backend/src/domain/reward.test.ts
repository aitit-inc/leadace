import { describe, it, expect } from 'vitest'
import { countableReply, replyReward, defaultRewardWeights, rewardWeightsSchema } from './reward'

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

describe('replyReward (default weights)', () => {
  it('gives full reward to a meeting request, regardless of sentiment', () => {
    expect(replyReward({ responseType: 'meeting_request', sentiment: 'positive' })).toBe(1)
    expect(replyReward({ responseType: 'meeting_request', sentiment: 'negative' })).toBe(1)
  })

  it('grades a plain reply by sentiment', () => {
    expect(replyReward({ responseType: 'reply', sentiment: 'positive' })).toBe(1)
    expect(replyReward({ responseType: 'reply', sentiment: 'neutral' })).toBe(0.5)
    expect(replyReward({ responseType: 'reply', sentiment: 'negative' })).toBe(0)
  })

  it('gives zero reward to a rejection (a reply, but not a positive outcome)', () => {
    expect(replyReward({ responseType: 'rejection', sentiment: 'negative' })).toBe(0)
    expect(replyReward({ responseType: 'rejection', sentiment: 'neutral' })).toBe(0)
  })

  it('never rewards machine noise', () => {
    expect(replyReward({ responseType: 'bounce', sentiment: 'neutral' })).toBe(0)
    expect(replyReward({ responseType: 'auto_reply', sentiment: 'positive' })).toBe(0)
  })
})

describe('replyReward (custom weights)', () => {
  it('honors a config that weights neutral replies fully and rejections positively', () => {
    const weights = rewardWeightsSchema.parse({ neutralReply: 1, negativeReply: 0.25 })
    expect(replyReward({ responseType: 'reply', sentiment: 'neutral' }, weights)).toBe(1)
    expect(replyReward({ responseType: 'rejection', sentiment: 'negative' }, weights)).toBe(0.25)
    expect(weights.meetingRequest).toBe(defaultRewardWeights.meetingRequest)
  })

  it('rejects negative weights', () => {
    expect(() => rewardWeightsSchema.parse({ positiveReply: -1 })).toThrow()
  })
})
