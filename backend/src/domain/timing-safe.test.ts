import { describe, it, expect } from 'vitest'
import { timingSafeEqual } from './timing-safe'

// Only correctness is asserted here; the constant-time property is a runtime
// characteristic a unit test cannot observe.
describe('timingSafeEqual', () => {
  it('is true for identical strings (including empty)', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('is false when lengths differ', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })

  it('is false for a single differing byte at any position', () => {
    expect(timingSafeEqual('abcde', 'Abcde')).toBe(false)
    expect(timingSafeEqual('abcde', 'abcdE')).toBe(false)
  })
})
