import { describe, it, expect } from 'vitest'
import { planFromMetadata, effectivePlanFromStatus } from './stripe-webhook'

describe('planFromMetadata', () => {
  it('maps a known paid plan from price metadata', () => {
    expect(planFromMetadata({ plan: 'pro' })).toBe('pro')
    expect(planFromMetadata({ plan: 'starter' })).toBe('starter')
    expect(planFromMetadata({ plan: 'scale' })).toBe('scale')
  })

  it('returns null for missing or unknown plan metadata', () => {
    expect(planFromMetadata(undefined)).toBeNull()
    expect(planFromMetadata({})).toBeNull()
    expect(planFromMetadata({ plan: 'enterprise' })).toBeNull()
    expect(planFromMetadata({ plan: 'free' })).toBeNull()
  })
})

describe('effectivePlanFromStatus', () => {
  it('grants the paid tier only while active or trialing', () => {
    expect(effectivePlanFromStatus('active', 'pro')).toBe('pro')
    expect(effectivePlanFromStatus('trialing', 'starter')).toBe('starter')
  })

  it('falls back to free for any non-active status', () => {
    expect(effectivePlanFromStatus('incomplete', 'pro')).toBe('free')
    expect(effectivePlanFromStatus('past_due', 'pro')).toBe('free')
    expect(effectivePlanFromStatus('canceled', 'scale')).toBe('free')
    expect(effectivePlanFromStatus(undefined, 'pro')).toBe('free')
  })

  it('falls back to free when no plan is resolved, even if active', () => {
    expect(effectivePlanFromStatus('active', null)).toBe('free')
  })
})
