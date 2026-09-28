import { describe, it, expect } from 'vitest'
import { decide, type TickEvidence } from './decide'
import { defaultLeverConfig } from './config'
import type { VariantStat } from './options'

const variant = (variantId: string, total: number, rewardSum: number): VariantStat => ({
  variantId,
  total,
  responses: Math.min(Math.ceil(rewardSum), total),
  rewardSum,
})
const flatArms = [variant('a', 100, 5), variant('b', 100, 5), variant('c', 100, 5)]
const flatSubject = { weights: {}, pBest: { a: 0.33, b: 0.33, c: 0.34 }, archived: [], samples: flatArms }

const evidence = (over: Partial<TickEvidence> = {}): TickEvidence => ({
  variants: flatArms,
  strategies: [],
  channel: [],
  targeting: { industry: [], employeeBand: [], country: [], discoveryStrategy: [] },
  futility: { sends: 0, engaged: 0 },
  registrations: {},
  recentSubjects: Array.from({ length: defaultLeverConfig.stagnationTicks - 1 }, () => flatSubject),
  unfulfilledRotation: false,
  ...over,
})

describe('decide', () => {
  it('decides the same way for the same evidence and day', () => {
    const a = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    const b = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('rotates the weakest arm out after a full flat streak', () => {
    const { variants } = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    expect(variants.toArchive).toHaveLength(1)
    expect(variants.toArchive[0]!.reason).toBe('stagnation')
    expect(Object.keys(variants.weights)).toHaveLength(2)
  })

  it('does not rotate while an earlier rotation still awaits its fresh angle', () => {
    const { variants } = decide(evidence({ unfulfilledRotation: true }), defaultLeverConfig, '2026-09-28', 'p1')
    expect(variants.toArchive).toEqual([])
  })

  it('does not rotate before the streak reaches stagnationTicks', () => {
    const short = evidence({ recentSubjects: [flatSubject] })
    expect(decide(short, defaultLeverConfig, '2026-09-28', 'p1').variants.toArchive).toEqual([])
  })

  it('a changed arm set breaks the streak', () => {
    const other = { ...flatSubject, samples: [variant('a', 100, 5), variant('b', 100, 5), variant('d', 100, 5)] }
    const broken = evidence({ recentSubjects: [flatSubject, other, flatSubject, flatSubject, flatSubject, flatSubject] })
    expect(decide(broken, defaultLeverConfig, '2026-09-28', 'p1').variants.toArchive).toEqual([])
  })

  it('journals the strategy decision by slug with the prior day registrations', () => {
    const e = evidence({
      strategies: [{ armId: 'loser', total: 100, rewardSum: 0 }, { armId: 'winner', total: 100, rewardSum: 20 }, { armId: 'fresh', total: 0, rewardSum: 0 }],
      registrations: { winner: 3 },
    })
    const { payload, strategies } = decide(e, defaultLeverConfig, '2026-09-28', 'p1')
    expect(strategies.toArchive.map((a) => a.armId)).toEqual(['loser'])
    expect(payload.discovery.archived.map((a) => a.slug)).toEqual(['loser'])
    expect(payload.discovery.registrations).toEqual({ winner: 3 })
    expect(payload.configUsed).toBe(defaultLeverConfig)
  })
})
