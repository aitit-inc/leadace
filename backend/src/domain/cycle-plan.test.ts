import { describe, expect, it } from 'vitest'
import { shouldBuildFirst, type ReachableSnapshot } from './cycle-plan'

const snap = (r: Omit<ReachableSnapshot, 'blocked'>, blocked: string | null = null): ReachableSnapshot => ({ ...r, blocked })

describe('shouldBuildFirst', () => {
  it('builds first on an empty list', () => {
    expect(shouldBuildFirst(snap({ total: 0, email: 0, formOnly: 0, platformOnly: 0 }), 30)).toBe(true)
  })
  it('never builds on a blocked day — an exhausted quota looks like an empty list', () => {
    expect(shouldBuildFirst(snap({ total: 0, email: 0, formOnly: 0, platformOnly: 0 }, 'quota exhausted'), 30)).toBe(false)
  })
  it('builds first when email is depleted and few form/platform prospects remain', () => {
    expect(shouldBuildFirst(snap({ total: 4, email: 0, formOnly: 3, platformOnly: 1 }), 30)).toBe(true)
    // Enough form / platform prospects carry the day even with no email.
    expect(shouldBuildFirst(snap({ total: 12, email: 0, formOnly: 5, platformOnly: 7 }), 30)).toBe(false)
  })
  it('builds first below a third of the outbound count, otherwise sends first', () => {
    expect(shouldBuildFirst(snap({ total: 9, email: 9, formOnly: 0, platformOnly: 0 }), 30)).toBe(true)
    expect(shouldBuildFirst(snap({ total: 10, email: 10, formOnly: 0, platformOnly: 0 }), 30)).toBe(false)
    expect(shouldBuildFirst(snap({ total: 40, email: 40, formOnly: 0, platformOnly: 0 }), 30)).toBe(false)
  })
})
