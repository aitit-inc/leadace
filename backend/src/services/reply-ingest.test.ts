import { describe, it, expect } from 'vitest'
import { clampReceivedAt } from './reply-ingest'

// The reply ingest clamps a captured reply's receivedAt into record_response's
// accepted [now-7d, now] window. A stale or sender-forged Date header that fell
// outside that window would otherwise be rejected (reply lost) or shift
// next_outreach_after. `now` is injected so the clamp is pure.
describe('clampReceivedAt', () => {
  const now = Date.parse('2026-06-10T12:00:00Z')

  it('passes a timestamp already inside the window through unchanged', () => {
    expect(clampReceivedAt(new Date('2026-06-08T00:00:00Z'), now)).toBe('2026-06-08T00:00:00.000Z')
  })

  it('clamps a future timestamp down to now', () => {
    expect(clampReceivedAt(new Date('2026-06-20T00:00:00Z'), now)).toBe('2026-06-10T12:00:00.000Z')
  })

  it('clamps a timestamp older than 7 days up to now-7d', () => {
    expect(clampReceivedAt(new Date('2026-05-01T00:00:00Z'), now)).toBe('2026-06-03T12:00:00.000Z')
  })

  it('keeps the exact now and now-7d boundaries', () => {
    expect(clampReceivedAt(new Date(now), now)).toBe('2026-06-10T12:00:00.000Z')
    expect(clampReceivedAt(new Date('2026-06-03T12:00:00Z'), now)).toBe('2026-06-03T12:00:00.000Z')
  })

  it('treats an invalid Date as now instead of throwing', () => {
    expect(clampReceivedAt(new Date('not a date'), now)).toBe('2026-06-10T12:00:00.000Z')
  })
})
