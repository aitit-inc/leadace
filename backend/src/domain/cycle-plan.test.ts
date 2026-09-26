import { describe, expect, it } from 'vitest'
import { MAX_DISCOVERY_PASSES, nextCycleStep } from './cycle-plan'

const base = { want: 20, deliverable: 0, last: null, discovery: null, passes: 0 } as const

describe('nextCycleStep', () => {
  it('writes to the list first, no more than the day still wants', () => {
    expect(nextCycleStep({ ...base, deliverable: 50 })).toEqual({ kind: 'draft', count: 20 })
    expect(nextCycleStep({ ...base, deliverable: 4 })).toEqual({ kind: 'draft', count: 4 })
  })
  it('searches for what is still wanted once the list runs out', () => {
    expect(nextCycleStep({ ...base, want: 16, last: { kind: 'draft', produced: 4, failed: 0 } })).toEqual({ kind: 'discover', count: 16 })
  })
  it('searches when the list is not empty but its last round wrote to no one', () => {
    expect(nextCycleStep({ ...base, deliverable: 40, last: { kind: 'draft', produced: 0, failed: 0 } })).toEqual({ kind: 'discover', count: 20 })
  })
  it('writes to what a pass found, and stops when a pass found nothing new', () => {
    expect(nextCycleStep({ ...base, deliverable: 3, last: { kind: 'discover', deliverableBefore: 0 } })).toEqual({ kind: 'draft', count: 3 })
    expect(nextCycleStep({ ...base, deliverable: 40, last: { kind: 'discover', deliverableBefore: 40 } })).toEqual({ kind: 'stop', stop: { kind: 'dry' } })
  })
  it('stops once the day has what it wants', () => {
    expect(nextCycleStep({ ...base, want: 0, deliverable: 40 })).toEqual({ kind: 'stop', stop: { kind: 'reached' } })
  })
  it('says why when it cannot search', () => {
    expect(nextCycleStep({ ...base, discovery: 'no_strategies' })).toEqual({ kind: 'stop', stop: { kind: 'no_discovery', why: 'no_strategies' } })
    expect(nextCycleStep({ ...base, deliverable: 9, discovery: { paused: 'allowance used' }, last: { kind: 'draft', produced: 0, failed: 3 } })).toEqual({ kind: 'stop', stop: { kind: 'list_spent', failed: 3 } })
  })
  it('stops a runaway day at the pass cap', () => {
    expect(nextCycleStep({ ...base, passes: MAX_DISCOVERY_PASSES, last: { kind: 'draft', produced: 1, failed: 0 } })).toEqual({ kind: 'stop', stop: { kind: 'pass_cap' } })
  })
})
