import { describe, it, expect } from 'vitest'
import { computePBest, seededRng, type ArmStat } from './bandit'
import { decideOptions, isFlat, type OptionArm } from './options'

const sum = (w: Record<string, number>): number => Object.values(w).reduce((a, b) => a + b, 0)

const arm = (armId: string, total = 0, rewardSum = 0): ArmStat => ({ armId, total, rewardSum })
// Out of its grace unless told otherwise: every send came since it entered.
const active = (armId: string, total = 0, rewardSum = 0, sinceEntry = total): OptionArm => ({ armId, total, rewardSum, sinceEntry })

const params = { minSamplePerArm: 30, archiveThreshold: 0.02, restoreThreshold: 0.3, slots: 3, weightFloor: 0.1 }
const rotation = { flatStreak: 6, stagnationDays: 7 }
const decide = (arms: OptionArm[], lost: ArmStat[] = [], rotate: typeof rotation | null = null) =>
  decideOptions(arms, lost, params, rotate, seededRng('s'))
const still = { toArchive: [], toRestore: [], flatStreak: 0 }

describe('decideOptions: lost', () => {
  it('no arms → empty', () => {
    expect(decide([])).toEqual({ weights: {}, pBest: {}, ...still })
  })
  it('deterministic under the same seed', () => {
    const arms = [active('a', 60, 20), active('b', 60, 10), active('c', 30, 5)]
    expect(decide(arms)).toEqual(decide(arms))
  })
  it('unsent arms never archive the only measured arm (n=154 with 3 replies vs three at n=0)', () => {
    const { toArchive, weights } = decide([active('measured', 154, 3), active('u1'), active('u2'), active('u3')])
    expect(toArchive).toEqual([])
    expect(weights['measured']!).toBeGreaterThanOrEqual(0.1)
  })
  it('a proven loser is archived against the leader while an unsent arm is present', () => {
    const { toArchive, weights } = decide([active('loser', 100, 0), active('winner', 100, 20), active('fresh')])
    expect(toArchive).toEqual([{ armId: 'loser', n: 100, pBeatsLeader: expect.any(Number) }])
    expect(toArchive[0]).toMatchObject({ pBeatsLeader: expect.closeTo(0, 1) })
    expect(Object.keys(weights).sort()).toEqual(['fresh', 'winner'])
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('one-on-one with the leader: a second strong arm does not make a middling one lose', () => {
    // Among all three its P(best) is near 0; against the leader alone it is not.
    const { toArchive } = decide([active('a', 200, 60), active('b', 200, 58), active('c', 200, 50)])
    expect(toArchive).toEqual([])
  })
  it('unproven arms are never archived', () => {
    expect(decide([active('a', 100, 50), active('b', 29, 0), active('c', 100, 40)]).toArchive).toEqual([])
  })
  it('an arm in its grace is not archived on the record from before it entered', () => {
    const arms = (sinceEntry: number) => [active('a', 200, 60), active('b', 200, 1, sinceEntry), active('c', 200, 50)]
    expect(decide(arms(29)).toArchive).toEqual([])
    expect(decide(arms(30)).toArchive.map((a) => a.armId)).toEqual(['b'])
  })
  it('never archives below 2 active', () => {
    const { weights, toArchive } = decide([active('a', 200, 100), active('b', 200, 0)])
    expect(toArchive).toEqual([])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b'])
  })
  it('caps archiving to keep 2 active, shedding the worst first', () => {
    const { toArchive } = decide([active('a', 200, 100), active('b', 200, 1), active('c', 200, 2)])
    // b and c both score ≈ 0 against a — the posterior-mean tie-break sheds the weaker b.
    expect(toArchive.map((a) => a.armId)).toEqual(['b'])
  })
})

describe('decideOptions: restore', () => {
  const running = [active('a', 100, 10), active('b', 100, 9)]
  it('a lost option that now matches the leader returns to a free slot, in its grace', () => {
    const { toRestore, weights, toArchive } = decide(running, [arm('back', 100, 10)])
    expect(toRestore).toEqual([{ armId: 'back', n: 100, pBeatsLeader: expect.any(Number) }])
    expect(toRestore[0]!.pBeatsLeader).toBeGreaterThanOrEqual(0.3)
    expect(toArchive).toEqual([])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b', 'back'])
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('stays out below the restore threshold', () => {
    expect(decide(running, [arm('weak', 100, 4)]).toRestore).toEqual([])
  })
  it('stays out without a free slot', () => {
    expect(decide([...running, active('c', 100, 9)], [arm('back', 100, 10)]).toRestore).toEqual([])
  })
  it('the best scores take the free slots first', () => {
    const { toRestore } = decide([active('a', 100, 10), active('b', 100, 9)], [arm('good', 100, 10), arm('better', 100, 14)])
    expect(toRestore.map((r) => r.armId)).toEqual(['better'])
  })
  it('a lost leader sets the bar for the active set and takes the slot its loser frees', () => {
    const { toArchive, toRestore, weights } = decide(
      [active('a', 200, 40), active('b', 200, 38), active('worst', 200, 3)],
      [arm('leader', 200, 60)],
    )
    expect(toArchive.map((a) => a.armId)).toEqual(['worst'])
    expect(toRestore.map((r) => r.armId)).toEqual(['leader'])
    expect(Object.keys(weights).sort()).toEqual(['a', 'b', 'leader'])
  })
})

describe('decideOptions: rotation', () => {
  const flat = [active('a', 40, 5), active('b', 40, 4), active('c', 40, 5)]
  it('a set flat for stagnationDays in a row sheds its weakest arm and starts the count over', () => {
    const { toArchive, weights, pBest, flatStreak } = decide(flat, [], rotation)
    expect(toArchive).toEqual([{ armId: 'b', n: 40, pBest: pBest['b'], reason: 'stagnation' }])
    expect(flatStreak).toBe(0)
    expect(Object.keys(weights).sort()).toEqual(['a', 'c'])
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('a flat day short of that only counts', () => {
    const { toArchive, flatStreak } = decide(flat, [], { ...rotation, flatStreak: 5 })
    expect(toArchive).toEqual([])
    expect(flatStreak).toBe(6)
  })
  it('a day with a clear leader starts the count over', () => {
    expect(decide([active('a', 40, 20), active('b', 40, 4), active('c', 40, 5)], [], rotation).flatStreak).toBe(0)
  })
  it('not for a layer that never rotates', () => {
    expect(decide(flat, [], null)).toMatchObject(still)
  })
  it('not while an arm is still in its grace', () => {
    expect(decide([active('a', 40, 5), active('b', 40, 4, 10), active('c', 40, 5)], [], rotation)).toMatchObject(still)
  })
  it('not on a day an option was lost', () => {
    const { toArchive, flatStreak } = decide([active('a', 200, 21), active('b', 200, 20), active('c', 200, 19), active('d', 200, 0)], [], rotation)
    expect(toArchive.map((a) => 'reason' in a)).toEqual([false])
    expect(flatStreak).toBe(0)
  })
})

describe('isFlat', () => {
  const arms = [active('a', 40, 4), active('b', 40, 4), active('c', 40, 4)]
  it('all proven and max P(best) below the ceiling → flat', () => {
    expect(isFlat(arms, { a: 0.34, b: 0.33, c: 0.33 }, 30)).toBe(true)
  })
  it('one unproven arm → not flat (still learning)', () => {
    expect(isFlat([active('a', 40, 4), active('b', 29, 4), active('c', 40, 4)], { a: 0.34, b: 0.33, c: 0.33 }, 30)).toBe(false)
  })
  it('a leader at or above the ceiling → not flat', () => {
    expect(isFlat(arms, { a: 0.5, b: 0.25, c: 0.25 }, 30)).toBe(false)
  })
  it('2 arms can never be flat at the 0.5 ceiling (their P(best) sum to 1)', () => {
    expect(isFlat([active('a', 40, 4), active('b', 40, 4)], { a: 0.5, b: 0.5 }, 30)).toBe(false)
  })
})

describe('decideOptions: weights', () => {
  it('sum to 1 and tilt toward the stronger arm from the first data', () => {
    const { weights } = decide([active('a', 40, 16), active('b', 40, 4)])
    expect(sum(weights)).toBeCloseTo(1, 10)
    expect(weights['a']!).toBeGreaterThan(weights['b']!)
  })
  it('the floor keeps a sunk unproven arm drawable', () => {
    const { weights, toArchive } = decide([active('a', 100, 50), active('b', 20, 0), active('c', 100, 40)])
    expect(toArchive).toEqual([])
    expect(weights['b']!).toBeGreaterThan(0.03)
  })
  it('an unproven arm gets at most an even share of the slots; the proven arms take the excess', () => {
    // Unsent arms draw around 0.5 and would take most of the weight.
    const { weights } = decide([active('proven', 200, 6), active('new1'), active('new2')])
    expect(weights['new1']!).toBeLessThanOrEqual(1 / 3 + 1e-12)
    expect(weights['new2']!).toBeLessThanOrEqual(1 / 3 + 1e-12)
    expect(weights['proven']!).toBeGreaterThanOrEqual(1 / 3 - 1e-12)
    expect(sum(weights)).toBeCloseTo(1, 10)
  })
  it('with nothing proven the split is even', () => {
    expect(decide([active('a', 5, 1), active('b'), active('c')]).weights).toEqual({ a: 1 / 3, b: 1 / 3, c: 1 / 3 })
  })
})

describe('computePBest', () => {
  it('no arms → empty; single arm → certainty', () => {
    expect(computePBest([], seededRng('s'))).toEqual({})
    expect(computePBest([arm('a', 100, 50)], seededRng('s'))).toEqual({ a: 1 })
  })
  it('sums to 1 and favors the clearly better arm', () => {
    const p = computePBest([arm('a', 100, 50), arm('b', 100, 5)], seededRng('s'))
    expect(sum(p)).toBeCloseTo(1, 10)
    expect(p['a']!).toBeGreaterThan(0.95)
  })
  it('no data → roughly uniform (R5: nothing to favor)', () => {
    const p = computePBest([arm('a', 0, 0), arm('b', 0, 0), arm('c', 0, 0)], seededRng('s'))
    for (const id of ['a', 'b', 'c']) {
      expect(p[id]!).toBeGreaterThan(0.25)
      expect(p[id]!).toBeLessThan(0.42)
    }
  })
  it('multi-reply rewardSum above total is clamped, not a crash', () => {
    // One send can draw several countable replies: rewardSum 15 on total 10.
    const p = computePBest([arm('a', 10, 15), arm('b', 10, 2)], seededRng('s'))
    expect(Number.isFinite(p['a']!)).toBe(true)
    expect(sum(p)).toBeCloseTo(1, 10)
    expect(p['a']!).toBeGreaterThan(p['b']!)
  })
})
