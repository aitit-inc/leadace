import { describe, it, expect } from 'vitest'
import { accountDeletionSurveySchema, isStripeCancelTolerable } from './account-deletion'

describe('isStripeCancelTolerable', () => {
  it('tolerates an ok cancel', () => {
    expect(isStripeCancelTolerable({ ok: true, data: {} })).toBe(true)
  })

  it('tolerates resource_missing (already canceled by an earlier attempt)', () => {
    expect(
      isStripeCancelTolerable({ ok: false, data: { error: { code: 'resource_missing' } } }),
    ).toBe(true)
  })

  it('does NOT tolerate other Stripe error codes', () => {
    expect(
      isStripeCancelTolerable({ ok: false, data: { error: { code: 'api_key_expired' } } }),
    ).toBe(false)
  })

  it('does NOT tolerate a non-ok response with no error code', () => {
    expect(isStripeCancelTolerable({ ok: false, data: {} })).toBe(false)
    expect(isStripeCancelTolerable({ ok: false, data: { error: {} } })).toBe(false)
  })
})

describe('accountDeletionSurveySchema', () => {
  it('accepts a radio reason with no detail', () => {
    expect(accountDeletionSurveySchema.safeParse({ reason: 'too_expensive' }).success).toBe(true)
  })

  it('accepts "other" with detail', () => {
    expect(
      accountDeletionSurveySchema.safeParse({ reason: 'other', detail: 'switched stacks' }).success,
    ).toBe(true)
  })

  it('rejects "other" with no detail', () => {
    expect(accountDeletionSurveySchema.safeParse({ reason: 'other' }).success).toBe(false)
  })

  it('rejects "other" with blank/whitespace detail (trimmed to empty)', () => {
    expect(
      accountDeletionSurveySchema.safeParse({ reason: 'other', detail: '   ' }).success,
    ).toBe(false)
  })

  it('rejects an unknown reason', () => {
    expect(accountDeletionSurveySchema.safeParse({ reason: 'bored' }).success).toBe(false)
  })

  it('rejects detail over the 500-char cap', () => {
    expect(
      accountDeletionSurveySchema.safeParse({ reason: 'other', detail: 'x'.repeat(501) }).success,
    ).toBe(false)
  })
})
