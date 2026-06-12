import { describe, it, expect } from 'vitest'
import { refreshWriteSet } from './org-signals'

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
