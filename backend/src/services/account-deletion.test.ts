import { describe, it, expect } from 'vitest'
import { isStripeCancelTolerable } from './account-deletion'

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
