import { describe, it, expect } from 'vitest'
import {
  countableReply,
  defaultRewardWeights,
  inquiryReward,
  inquiryRewardByKey,
  replyReward,
  REWARDED_INQUIRY_OUTCOMES,
  rewardWeightsSchema,
} from './reward'

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

describe('inquiryReward', () => {
  it('grades acting on the inquiry page like a reply', () => {
    expect(inquiryReward({ outcome: 'inquired' })).toBe(0.5)
    expect(inquiryReward({ outcome: 'signup_clicked' })).toBe(1)
  })

  it('gives nothing to an outcome that is not a human act, or already counted as a reply', () => {
    expect(inquiryReward({ outcome: 'opened' })).toBe(0)
    expect(inquiryReward({ outcome: 'lead' })).toBe(0)
    expect(inquiryReward({ outcome: 'unsubscribed' })).toBe(0)
  })

  it('names exactly the outcomes a query has to fetch', () => {
    expect([...REWARDED_INQUIRY_OUTCOMES]).toEqual(['inquired', 'signup_clicked'])
  })

  it('honors custom weights', () => {
    const weights = rewardWeightsSchema.parse({ inquiryChatEngaged: 0.25 })
    expect(inquiryReward({ outcome: 'inquired' }, weights)).toBe(0.25)
    expect(inquiryReward({ outcome: 'signup_clicked' }, weights)).toBe(defaultRewardWeights.inquirySignupClicked)
  })
})

describe('inquiryRewardByKey', () => {
  it('takes the strongest outcome of a send, never the sum of its sessions', () => {
    const byKey = inquiryRewardByKey([
      { key: 'yc-hn', outreachLogId: 1, outcome: 'inquired' },
      { key: 'yc-hn', outreachLogId: 1, outcome: 'signup_clicked' },
    ])
    expect(byKey.get('yc-hn')).toBe(1)
  })

  it('sums across sends and splits by key', () => {
    const byKey = inquiryRewardByKey([
      { key: 'yc-hn', outreachLogId: 1, outcome: 'inquired' },
      { key: 'yc-hn', outreachLogId: 2, outcome: 'inquired' },
      { key: 'product-hunt', outreachLogId: 3, outcome: 'signup_clicked' },
    ])
    expect(byKey.get('yc-hn')).toBe(1)
    expect(byKey.get('product-hunt')).toBe(1)
  })

  it('scores nothing when every session is an unrewarded outcome', () => {
    const byKey = inquiryRewardByKey([
      { key: 'yc-hn', outreachLogId: 1, outcome: 'opened' },
      { key: 'yc-hn', outreachLogId: 2, outcome: 'lead' },
    ])
    expect(byKey.get('yc-hn')).toBe(0)
  })
})
