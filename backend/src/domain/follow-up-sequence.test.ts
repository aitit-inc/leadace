import { describe, it, expect } from 'vitest'
import {
  followUpSequenceSchema,
  followUpSequencePatchSchema,
  defaultFollowUpSequence,
} from './follow-up-sequence'

describe('followUpSequenceSchema', () => {
  it('parses an empty object into the opt-out-off default cadence', () => {
    // enabled:false is load-bearing: existing rows ({}) must read back OFF.
    expect(defaultFollowUpSequence).toEqual({ enabled: false, gapDays: [3, 7, 7] })
  })

  it('merges a partial override with the defaults', () => {
    const cfg = followUpSequenceSchema.parse({ enabled: true })
    expect(cfg.enabled).toBe(true)
    expect(cfg.gapDays).toEqual([3, 7, 7])
  })

  it('accepts a custom gap schedule', () => {
    expect(followUpSequenceSchema.parse({ gapDays: [2, 5] }).gapDays).toEqual([2, 5])
  })

  it('rejects an empty or over-long gap schedule', () => {
    expect(() => followUpSequenceSchema.parse({ gapDays: [] })).toThrow()
    expect(() => followUpSequenceSchema.parse({ gapDays: [1, 1, 1, 1, 1, 1] })).toThrow()
  })

  it('rejects a non-positive or out-of-range gap', () => {
    expect(() => followUpSequenceSchema.parse({ gapDays: [0] })).toThrow()
    expect(() => followUpSequenceSchema.parse({ gapDays: [91] })).toThrow()
  })
})

describe('followUpSequencePatchSchema (overrides-only storage)', () => {
  it('stores only the fields the caller set — no defaults filled', () => {
    // No-backfill: an unset field must not be frozen into the cell.
    expect(followUpSequencePatchSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(followUpSequencePatchSchema.parse({})).toEqual({})
  })

  it('still enforces the field constraints', () => {
    expect(() => followUpSequencePatchSchema.parse({ gapDays: [0] })).toThrow()
    expect(() => followUpSequencePatchSchema.parse({ gapDays: [] })).toThrow()
  })
})
