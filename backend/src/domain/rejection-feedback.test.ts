import { describe, it, expect } from 'vitest'
import type { RejectionFeedbackV1 } from '../db/schema'
import {
  feedbackForcesDoNotContact,
  reapproachWindowMonths,
  resolveEffectiveReapproachWindow,
} from './rejection-feedback'

const fb = (over: Partial<RejectionFeedbackV1>): RejectionFeedbackV1 => ({
  version: 1,
  primary_reason: 'not_relevant',
  submitted_at: '2025-01-01T00:00:00.000Z',
  ...over,
})

describe('feedbackForcesDoNotContact', () => {
  it('forces DNC on an explicit unsubscribe request', () => {
    expect(feedbackForcesDoNotContact(fb({ primary_reason: 'unsubscribe_request' }))).toBe(true)
  })

  it('forces DNC when the recipient picked the "never" window', () => {
    expect(feedbackForcesDoNotContact(fb({ preferred_recontact_window: 'never' }))).toBe(true)
  })

  it('forces DNC on any hard consent opt-out', () => {
    expect(feedbackForcesDoNotContact(fb({ consent: { gdpr_erasure_request: true } }))).toBe(true)
    expect(feedbackForcesDoNotContact(fb({ consent: { ccpa_opt_out: true } }))).toBe(true)
    expect(feedbackForcesDoNotContact(fb({ consent: { marketing_opt_out: true } }))).toBe(true)
  })

  it('does not force DNC for an ordinary rejection', () => {
    expect(feedbackForcesDoNotContact(fb({ primary_reason: 'not_relevant' }))).toBe(false)
    expect(feedbackForcesDoNotContact(fb({ primary_reason: 'wrong_timing', preferred_recontact_window: '3_months' }))).toBe(false)
    expect(feedbackForcesDoNotContact(fb({ consent: { marketing_opt_out: false } }))).toBe(false)
  })
})

describe('reapproachWindowMonths', () => {
  const opts = { unspecifiedMonths: 4 }

  it('returns null when the reason is not a reapproach signal', () => {
    expect(reapproachWindowMonths(fb({ primary_reason: 'not_relevant', preferred_recontact_window: '3_months' }), opts)).toBeNull()
  })

  it('returns null when a reapproach reason carries no window', () => {
    expect(reapproachWindowMonths(fb({ primary_reason: 'wrong_timing' }), opts)).toBeNull()
  })

  it('maps concrete windows to their month length', () => {
    expect(reapproachWindowMonths(fb({ primary_reason: 'wrong_timing', preferred_recontact_window: '3_months' }), opts)).toBe(3)
    expect(reapproachWindowMonths(fb({ primary_reason: 'budget', preferred_recontact_window: '6_months' }), opts)).toBe(6)
    expect(reapproachWindowMonths(fb({ primary_reason: 'wrong_timing', preferred_recontact_window: '12_months' }), opts)).toBe(12)
  })

  it('resolves "unspecified" to the project fallback', () => {
    expect(reapproachWindowMonths(fb({ primary_reason: 'wrong_timing', preferred_recontact_window: 'unspecified' }), opts)).toBe(4)
  })

  it('treats "never" as no reapproach (null)', () => {
    expect(reapproachWindowMonths(fb({ primary_reason: 'wrong_timing', preferred_recontact_window: 'never' }), opts)).toBeNull()
  })
})

describe('resolveEffectiveReapproachWindow', () => {
  it('drops the window once the rejection cycle cap is reached', () => {
    expect(resolveEffectiveReapproachWindow({
      responseType: 'rejection', rejectionCycle: 3, maxReapproachCycles: 3, requestedWindowMonths: 6,
    })).toEqual({ cycleCapReached: true, effectiveWindowMonths: null })
  })

  it('keeps the requested window below the cap', () => {
    expect(resolveEffectiveReapproachWindow({
      responseType: 'rejection', rejectionCycle: 1, maxReapproachCycles: 3, requestedWindowMonths: 6,
    })).toEqual({ cycleCapReached: false, effectiveWindowMonths: 6 })
  })

  it('never caps non-rejection responses, regardless of cycle count', () => {
    expect(resolveEffectiveReapproachWindow({
      responseType: 'reply', rejectionCycle: 99, maxReapproachCycles: 3, requestedWindowMonths: 3,
    })).toEqual({ cycleCapReached: false, effectiveWindowMonths: 3 })
  })
})
