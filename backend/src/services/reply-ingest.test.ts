import { describe, it, expect } from 'vitest'
import { clampReceivedAt, pollCapCutsSinceLastPoll, recordFieldsForReply } from './reply-ingest'

// The reply ingest clamps a captured reply's receivedAt into record_response's
// accepted [now-7d, now] window. A stale or sender-forged Date header that fell
// outside that window would otherwise be rejected (reply lost) or shift
// next_outreach_after.
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

describe('recordFieldsForReply', () => {
  const iso = '2026-06-10T12:00:00.000Z'

  it('maps a threaded unsubscribe to a do-not-contact rejection with unsubscribe_request', () => {
    const fields = recordFieldsForReply('unsubscribe', iso, true)
    expect(fields.responseType).toBe('rejection')
    expect(fields.markDoNotContact).toBe(true)
    expect(fields.rejectionFeedback).toEqual({
      version: 1,
      primary_reason: 'unsubscribe_request',
      submitted_at: iso,
    })
  })

  it('downgrades a non-threaded (forgeable) unsubscribe to a per-project rejection, no DNC', () => {
    const fields = recordFieldsForReply('unsubscribe', iso, false)
    expect(fields.responseType).toBe('rejection')
    expect(fields.markDoNotContact).toBe(false)
    expect(fields.rejectionFeedback).toBeUndefined()
  })

  it('maps a LATER micro-reply to a wrong_timing rejection with the unspecified recontact window', () => {
    for (const trusted of [true, false]) {
      const fields = recordFieldsForReply('micro_later', iso, trusted)
      expect(fields.responseType).toBe('rejection')
      expect(fields.markDoNotContact).toBe(false)
      expect(fields.rejectionFeedback).toEqual({
        version: 1,
        primary_reason: 'wrong_timing',
        preferred_recontact_window: 'unspecified',
        submitted_at: iso,
      })
    }
  })

  it('maps a NOT ME micro-reply to a not_decision_maker rejection, no DNC', () => {
    const fields = recordFieldsForReply('micro_not_me', iso, true)
    expect(fields.responseType).toBe('rejection')
    expect(fields.markDoNotContact).toBe(false)
    expect(fields.rejectionFeedback).toEqual({
      version: 1,
      primary_reason: 'not_decision_maker',
      submitted_at: iso,
    })
  })

  it('passes every other type through without forcing do-not-contact', () => {
    for (const t of ['reply', 'meeting_request', 'rejection', 'bounce', 'auto_reply'] as const) {
      const fields = recordFieldsForReply(t, iso, true)
      expect(fields.responseType).toBe(t)
      expect(fields.markDoNotContact).toBe(false)
      expect(fields.rejectionFeedback).toBeUndefined()
    }
  })
})

describe('pollCapCutsSinceLastPoll', () => {
  const lastPoll = new Date('2026-08-28T13:00:00.000Z')
  const at = (minutesAfterLastPoll: number) => new Date(lastPoll.getTime() + minutesAfterLastPoll * 60_000)

  it('is false below the cap', () => {
    expect(pollCapCutsSinceLastPoll([at(10), at(20)], 3, lastPoll)).toBe(false)
  })

  it('is false when the capped batch still reaches back past the last poll', () => {
    expect(pollCapCutsSinceLastPoll([at(-5), at(10), at(20)], 3, lastPoll)).toBe(false)
  })

  it('is true when every fetched message arrived after the last poll', () => {
    expect(pollCapCutsSinceLastPoll([at(1), at(10), at(20)], 3, lastPoll)).toBe(true)
  })
})
