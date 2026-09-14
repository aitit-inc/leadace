import { describe, it, expect } from 'vitest'
import {
  autoTopUpSchema,
  creditAmountSchema,
  creditMetadata,
  creditsCoverOverage,
  formatCents,
  invoicePaidAt,
  isCardDecline,
  isStaleTopUpClaim,
  nextFoundRegistration,
  type AutoTopUp,
  type CreditState,
} from './credits'

const topUp = (enabled = false): AutoTopUp => ({ enabled, amountCents: 2500, thresholdCents: 500, failedAt: null })
const state = (balanceCents: number, enabled = false): CreditState => ({ balanceCents, autoTopUp: topUp(enabled) })

describe('creditAmountSchema', () => {
  it('accepts any whole-dollar amount from $10 to $500', () => {
    expect(creditAmountSchema.safeParse(1000).success).toBe(true)
    expect(creditAmountSchema.safeParse(1700).success).toBe(true)
    expect(creditAmountSchema.safeParse(50_000).success).toBe(true)
    expect(creditAmountSchema.safeParse(900).success).toBe(false)
    expect(creditAmountSchema.safeParse(50_100).success).toBe(false)
    expect(creditAmountSchema.safeParse(1050).success).toBe(false)
  })
})

describe('autoTopUpSchema', () => {
  it('bounds the threshold to $1–$100 and the amount to the purchase range', () => {
    expect(autoTopUpSchema.safeParse({ enabled: true, amountCents: 1700, thresholdCents: 100 }).success).toBe(true)
    expect(autoTopUpSchema.safeParse({ enabled: true, thresholdCents: 99 }).success).toBe(false)
    expect(autoTopUpSchema.safeParse({ enabled: true, thresholdCents: 10_001 }).success).toBe(false)
    expect(autoTopUpSchema.safeParse({ enabled: true, amountCents: 1050 }).success).toBe(false)
  })
})

describe('creditsCoverOverage', () => {
  it('covers a unit only when the balance pays for it in full', () => {
    expect(creditsCoverOverage(state(40), 40)).toBe(true)
    expect(creditsCoverOverage(state(39), 40)).toBe(false)
    expect(creditsCoverOverage(state(0), 40)).toBe(false)
  })

  it('does not let auto top-up stand in for balance', () => {
    expect(creditsCoverOverage(state(39, true), 40)).toBe(false)
  })

  it('is never covered on a plan without credits', () => {
    expect(creditsCoverOverage(null, 40)).toBe(false)
  })
})

describe('creditMetadata', () => {
  it('reads the tenant and amount stamped on the Stripe object', () => {
    expect(creditMetadata({ metadata: { leadace_tenant_id: 't1', leadace_credit_cents: '2500' } }))
      .toEqual({ tenantId: 't1', amountCents: 2500 })
  })

  it('rejects renewal invoices and malformed amounts', () => {
    expect(creditMetadata({ metadata: {} })).toBeNull()
    expect(creditMetadata({ metadata: { leadace_tenant_id: 't1', leadace_credit_cents: '25.5' } })).toBeNull()
    expect(creditMetadata({ metadata: { leadace_tenant_id: 't1', leadace_credit_cents: '0' } })).toBeNull()
  })
})

describe('invoicePaidAt', () => {
  const now = new Date('2026-09-15T00:00:00Z')
  it('reads the paid_at transition and falls back to now', () => {
    expect(invoicePaidAt({ status_transitions: { paid_at: 1789400000 } }, now)).toEqual(new Date(1789400000 * 1000))
    expect(invoicePaidAt({ status_transitions: { paid_at: null } }, now)).toBe(now)
    expect(invoicePaidAt({}, now)).toBe(now)
  })
})

describe('isCardDecline', () => {
  it('only a card_error is the customer’s problem', () => {
    expect(isCardDecline({ error: { type: 'card_error', code: 'card_declined' } })).toBe(true)
    expect(isCardDecline({ error: { type: 'invalid_request_error' } })).toBe(false)
    expect(isCardDecline({})).toBe(false)
  })
})

describe('isStaleTopUpClaim', () => {
  const now = new Date('2026-09-14T12:00:00Z')
  it('expires a claim after the TTL and ignores real invoice ids', () => {
    expect(isStaleTopUpClaim('claim:2026-09-14T11:55:00.000Z', now)).toBe(false)
    expect(isStaleTopUpClaim('claim:2026-09-14T11:50:00.000Z', now)).toBe(true)
    expect(isStaleTopUpClaim('claim:garbage', now)).toBe(true)
    expect(isStaleTopUpClaim('in_123', now)).toBe(false)
  })
})

describe('nextFoundRegistration', () => {
  it('uses a free slot before charging', () => {
    expect(nextFoundRegistration(1, 0)).toEqual({ charge: false })
  })

  it('charges $0.60 against the running balance once the slots are gone', () => {
    expect(nextFoundRegistration(0, 150)).toEqual({ charge: true, balanceAfterCents: 90 })
    expect(nextFoundRegistration(0, 60)).toEqual({ charge: true, balanceAfterCents: 0 })
  })

  it('stops when the running balance no longer pays for a unit', () => {
    expect(nextFoundRegistration(0, 59)).toBeNull()
    expect(nextFoundRegistration(0, null)).toBeNull()
  })
})

describe('formatCents', () => {
  it('renders dollars with the sign in front', () => {
    expect(formatCents(2500)).toBe('$25.00')
    expect(formatCents(-40)).toBe('-$0.40')
  })
})
