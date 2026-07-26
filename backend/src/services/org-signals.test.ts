import { describe, it, expect } from 'vitest'
import { redirectTarget, refreshWriteSet } from './org-signals'

describe('refreshWriteSet', () => {
  const now = new Date('2026-06-12T03:00:00Z')

  it('success bumps both timestamps and replaces the payload', () => {
    const signals = { highlights: ['Raised Series B on 2026-05-20'] }
    expect(refreshWriteSet(signals, now)).toEqual({
      lastAttemptAt: now,
      signals,
      signalsUpdatedAt: now,
    })
  })

  it('failure / no-signals bumps only last_attempt_at', () => {
    const set = refreshWriteSet(null, now)
    expect(set).toEqual({ lastAttemptAt: now })
    // Absent, not present-but-undefined — the conflict-update set must never
    // name these columns.
    expect('signals' in set).toBe(false)
    expect('signalsUpdatedAt' in set).toBe(false)
  })
})

// An empty Location resolves back to the URL we just fetched, so mistaking one
// for a redirect refetches the same page until the hop cap stops it.
describe('redirectTarget', () => {
  const withLocation = (status: number, location?: string) =>
    new Response(null, {
      status,
      headers: location === undefined ? undefined : { location },
    })

  it('returns the target of a redirect', () => {
    expect(redirectTarget(withLocation(301, 'https://acme.com/next'))).toBe('https://acme.com/next')
  })

  it('treats a missing, empty, or blank Location as no redirect', () => {
    expect(redirectTarget(withLocation(302))).toBeNull()
    expect(redirectTarget(withLocation(302, ''))).toBeNull()
    expect(redirectTarget(withLocation(302, '   '))).toBeNull()
  })

  it('ignores Location outside the 3xx range', () => {
    expect(redirectTarget(withLocation(200, 'https://acme.com/next'))).toBeNull()
    expect(redirectTarget(withLocation(404, 'https://acme.com/next'))).toBeNull()
  })
})
