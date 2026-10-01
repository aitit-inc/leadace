import { describe, it, expect } from 'vitest'
import { decide, type TickEvidence } from './decide'
import { defaultLeverConfig } from './config'

const variant = (armId: string, total: number, rewardSum: number): TickEvidence['variants']['active'][number] => ({
  armId,
  total,
  responses: Math.min(Math.ceil(rewardSum), total),
  rewardSum,
  sinceEntry: total,
})
const flatArms = [variant('a', 100, 5), variant('b', 100, 5), variant('c', 100, 5)]

const evidence = (over: Partial<TickEvidence> = {}): TickEvidence => ({
  variants: { active: flatArms, lost: [], flatStreak: defaultLeverConfig.stagnationTicks - 1 },
  strategies: { active: [], lost: [] },
  channel: [],
  targeting: { industry: [], employeeBand: [], country: [], discoveryStrategy: [] },
  futility: { sends: 0, engaged: 0 },
  ...over,
})

describe('decide', () => {
  it('decides the same way for the same evidence and day', () => {
    const a = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    const b = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('rotates the weakest variant out of a set flat for stagnationTicks days', () => {
    const { variants, payload } = decide(evidence(), defaultLeverConfig, '2026-09-28', 'p1')
    expect(variants.toArchive).toHaveLength(1)
    expect(variants.toArchive[0]).toMatchObject({ reason: 'stagnation' })
    expect(Object.keys(variants.weights)).toHaveLength(2)
    expect(payload.subject.archived).toEqual(variants.toArchive.map(({ armId, ...rest }) => ({ variantId: armId, ...rest })))
    expect(payload.subject.samples.map((s) => s.variantId)).toEqual(['a', 'b', 'c'])
  })

  it('does not rotate before the streak reaches stagnationTicks', () => {
    const short = evidence({ variants: { active: flatArms, lost: [], flatStreak: 1 } })
    const { variants } = decide(short, defaultLeverConfig, '2026-09-28', 'p1')
    expect(variants.toArchive).toEqual([])
    expect(variants.flatStreak).toBe(2)
  })

  it('never rotates strategies, and journals their decision by slug', () => {
    const flat = flatArms.map(({ responses: _responses, ...a }) => a)
    const flatStrategies = decide(evidence({ strategies: { active: flat, lost: [] } }), defaultLeverConfig, '2026-09-28', 'p1')
    expect(flatStrategies.strategies.toArchive).toEqual([])

    const e = evidence({
      strategies: {
        active: [
          { armId: 'loser', total: 100, rewardSum: 0, sinceEntry: 100 },
          { armId: 'winner', total: 100, rewardSum: 20, sinceEntry: 100 },
          { armId: 'fresh', total: 0, rewardSum: 0, sinceEntry: 0 },
        ],
        lost: [{ armId: 'back', total: 100, rewardSum: 21 }],
      },
    })
    const { payload, strategies } = decide(e, defaultLeverConfig, '2026-09-28', 'p1')
    expect(strategies.toArchive.map((a) => a.armId)).toEqual(['loser'])
    expect(payload.discovery.archived.map((a) => a.slug)).toEqual(['loser'])
    expect(strategies.toRestore.map((r) => r.armId)).toEqual(['back'])
    expect(Object.keys(payload.discovery.weights).sort()).toEqual(['back', 'fresh', 'winner'])
    expect(payload.configUsed).toBe(defaultLeverConfig)
  })

  it('a stored archiveThreshold above restoreThreshold never restores what it would archive', () => {
    const e = evidence({
      strategies: {
        active: [{ armId: 'a', total: 100, rewardSum: 10, sinceEntry: 100 }, { armId: 'b', total: 100, rewardSum: 10, sinceEntry: 100 }],
        lost: [{ armId: 'back', total: 100, rewardSum: 9 }],
      },
    })
    expect(decide(e, defaultLeverConfig, '2026-09-28', 'p1').strategies.toRestore.map((r) => r.armId)).toEqual(['back'])
    const stored = { ...defaultLeverConfig, archiveThreshold: 0.6 }
    expect(decide(e, stored, '2026-09-28', 'p1').strategies.toRestore).toEqual([])
  })
})
