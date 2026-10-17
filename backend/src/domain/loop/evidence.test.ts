import { describe, expect, it } from 'vitest'
import { evidenceBy, evidenceOf, replyArrivalShare, type SendObservation } from './evidence'
import { defaultRewardWeights, type Reaction } from './reaction'
import type { RejectionPrimaryReason } from '../../db/schema'

const NOW = new Date('2026-10-17T00:00:00Z')
const daysBefore = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)

const send = (ageDays: number, reactions: Reaction[], over: Partial<SendObservation> = {}): SendObservation => ({
  outreachLogId: 1,
  sentAt: daysBefore(ageDays),
  variantId: 'a',
  strategy: 's',
  channel: 'email',
  industry: null,
  employeeBand: 'unknown',
  country: null,
  priority: null,
  bounceable: true,
  reactions,
  ...over,
})
const reply = (responseType: 'reply' | 'meeting_request' | 'rejection' | 'bounce', sentiment: 'positive' | 'neutral' | 'negative', reason: RejectionPrimaryReason | null = null): Reaction => ({
  kind: 'reply',
  responseType,
  sentiment,
  reason,
})

describe('replyArrivalShare', () => {
  it('passes through the measured knots', () => {
    expect(replyArrivalShare(0)).toBe(0)
    expect(replyArrivalShare(1 / 96)).toBe(0)
    expect(replyArrivalShare(0.25)).toBeCloseTo(0.5)
    expect(replyArrivalShare(6)).toBeCloseTo(0.9)
    expect(replyArrivalShare(14)).toBe(1)
    expect(replyArrivalShare(90)).toBe(1)
  })
  it('rises with age', () => {
    expect(replyArrivalShare(1)).toBeGreaterThan(replyArrivalShare(0.5))
    expect(replyArrivalShare(10)).toBeGreaterThan(replyArrivalShare(6))
  })
})

describe('evidenceOf', () => {
  it('counts a reacted send as one trial the moment the reaction arrives', () => {
    const e = evidenceOf([send(0.1, [reply('reply', 'positive')])], NOW, defaultRewardWeights)
    expect(e).toMatchObject({ sends: 1, trials: 1, rewardSum: 1, positive: 1, interested: 1, declined: 0 })
  })
  it('counts a silent send by the share of replies that would have arrived by its age', () => {
    const e = evidenceOf([send(6, []), send(30, [])], NOW, defaultRewardWeights)
    expect(e.trials).toBeCloseTo(1.9)
    expect(e.rewardSum).toBe(0)
  })
  it('keeps a bounced send out of the trials and counts it as a bounce', () => {
    const e = evidenceOf([send(30, [reply('bounce', 'neutral')]), send(30, [], { bounceable: false })], NOW, defaultRewardWeights)
    expect(e).toMatchObject({ sends: 2, trials: 1, replied: 0, bounced: 1, bounceable: 1 })
  })
  it('counts a no as a trial with no reward, by its stated reason', () => {
    const e = evidenceOf(
      [send(1, [reply('rejection', 'negative', 'not_relevant')]), send(1, [reply('reply', 'negative')]), send(1, [reply('rejection', 'negative', 'budget')])],
      NOW,
      defaultRewardWeights,
    )
    expect(e).toMatchObject({ trials: 3, rewardSum: 0, replied: 3, interested: 0, declined: 3, reasons: { not_relevant: 1, budget: 1 } })
  })
  it('scores interest at its weight and counts it as interested, not positive', () => {
    const e = evidenceOf([send(1, [reply('reply', 'neutral')])], NOW, defaultRewardWeights)
    expect(e).toMatchObject({ trials: 1, rewardSum: 0.5, positive: 0, interested: 1 })
  })
})

describe('evidenceBy', () => {
  it('groups by key and leaves out a send whose key is undefined', () => {
    const by = evidenceBy(
      [send(30, [], { variantId: 'a' }), send(30, [reply('reply', 'positive')], { variantId: 'b' }), send(30, [], { variantId: null })],
      (s) => s.variantId ?? undefined,
      NOW,
      defaultRewardWeights,
    )
    expect([...by.keys()].sort()).toEqual(['a', 'b'])
    expect(by.get('b')).toMatchObject({ trials: 1, positive: 1 })
  })
})
