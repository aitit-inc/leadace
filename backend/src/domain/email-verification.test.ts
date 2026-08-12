import { describe, it, expect } from 'vitest'
import {
  MAILBOX_VERDICT_TTL_MS,
  isMailboxVerdictFresh,
  verifierResponseSchema,
  verifierStatusSchema,
  verifierDeliverabilityVerdict,
} from './email-verification'

describe('verifierStatusSchema', () => {
  it('degrades an unrecognised result to unknown instead of throwing', () => {
    expect(verifierStatusSchema.parse('brand_new_status')).toBe('unknown')
    expect(verifierStatusSchema.parse(null)).toBe('unknown')
  })

  it('parses a verifier payload down to its result', () => {
    expect(verifierResponseSchema.parse({ result: 'invalid', subresult: 'no_mailbox' })).toEqual({
      result: 'invalid',
    })
  })

  it('rejects a payload without a recognised result, so an error-shaped response is never an answer', () => {
    expect(verifierResponseSchema.safeParse({ result: 'weird' }).success).toBe(false)
    expect(verifierResponseSchema.safeParse({ error: 'api_key_invalid' }).success).toBe(false)
  })
})

describe('verifierDeliverabilityVerdict', () => {
  it('blocks only a provably dead mailbox', () => {
    expect(verifierDeliverabilityVerdict('invalid')).toBe('undeliverable')
  })

  it('sends when the verifier cannot tell', () => {
    expect(verifierDeliverabilityVerdict('catch_all')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('unknown')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('error')).toBe('unknown')
  })

  it('sends to mailboxes that exist even when they are undesirable targets', () => {
    expect(verifierDeliverabilityVerdict('disposable')).toBe('unknown')
    expect(verifierDeliverabilityVerdict('ok')).toBe('unknown')
  })
})

describe('isMailboxVerdictFresh', () => {
  const now = new Date('2026-08-11T00:00:00Z')

  it('treats a never-answered row as stale', () => {
    expect(isMailboxVerdictFresh(null, now)).toBe(false)
  })

  it('is fresh strictly inside the TTL and stale at the boundary', () => {
    expect(isMailboxVerdictFresh(new Date(now.getTime() - MAILBOX_VERDICT_TTL_MS + 1), now)).toBe(true)
    expect(isMailboxVerdictFresh(new Date(now.getTime() - MAILBOX_VERDICT_TTL_MS), now)).toBe(false)
  })
})
