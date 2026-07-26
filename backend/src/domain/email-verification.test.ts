import { describe, it, expect } from 'vitest'
import {
  verifierResponseSchema,
  verifierStatusSchema,
  verifierDeliverabilityVerdict,
} from './email-verification'

describe('verifierStatusSchema', () => {
  it('degrades an unrecognised status to unknown instead of throwing', () => {
    expect(verifierStatusSchema.parse('brand_new_status')).toBe('unknown')
    expect(verifierStatusSchema.parse(null)).toBe('unknown')
  })

  it('parses a verifier payload down to its status', () => {
    expect(verifierResponseSchema.parse({ status: 'disabled', overall_score: 4 })).toEqual({
      status: 'disabled',
    })
    expect(verifierResponseSchema.parse({ status: 'weird' })).toEqual({ status: 'unknown' })
  })
})

describe('verifierDeliverabilityVerdict', () => {
  it('blocks only permanent address-specific refusals', () => {
    expect(verifierDeliverabilityVerdict('invalid')).toBe('undeliverable')
    expect(verifierDeliverabilityVerdict('disabled')).toBe('undeliverable')
  })

  it('sends when the verifier cannot tell', () => {
    expect(verifierDeliverabilityVerdict('catch_all')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('role_account')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('unknown')).toBe('unknown')
  })

  it('does not block a mailbox that exists but is momentarily refusing', () => {
    expect(verifierDeliverabilityVerdict('inbox_full')).toBe('unknown')
  })

  it('sends on a clean verdict', () => {
    expect(verifierDeliverabilityVerdict('safe')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('valid')).toBe('unknown')
  })
})
