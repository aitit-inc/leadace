import { describe, expect, it } from 'vitest'
import { shouldBuildFirst, type ReachableSnapshot } from './cycle-plan'

const snap = (r: Partial<ReachableSnapshot>): ReachableSnapshot => ({ deliverable: 0, needsHands: 0, blocked: null, ...r })

describe('shouldBuildFirst', () => {
  it('builds first on an empty list', () => {
    expect(shouldBuildFirst(snap({}), 30)).toBe(true)
  })
  it('never builds on a blocked day — an exhausted quota looks like an empty list', () => {
    expect(shouldBuildFirst(snap({ blocked: 'quota exhausted' }), 30)).toBe(false)
  })
  it('does not count what only a browser can reach — form-only rows do not carry a send-mode day', () => {
    expect(shouldBuildFirst(snap({ deliverable: 1, needsHands: 46 }), 10)).toBe(true)
  })
  it('builds first below a third of the outbound count, otherwise sends first', () => {
    expect(shouldBuildFirst(snap({ deliverable: 9 }), 30)).toBe(true)
    expect(shouldBuildFirst(snap({ deliverable: 10 }), 30)).toBe(false)
    expect(shouldBuildFirst(snap({ deliverable: 40 }), 30)).toBe(false)
  })
})
