import { describe, it, expect } from 'vitest'
import { planMovementOfEvent, type StripeSubscriptionEvent } from './account-activity'

const items = (plan?: string) => ({ data: [{ price: { metadata: plan ? { plan } : {} } }] })

const event = (
  type: string,
  object: Record<string, unknown>,
  previous?: Record<string, unknown>,
): StripeSubscriptionEvent => ({ type, data: { object, previous_attributes: previous } })

describe('planMovementOfEvent', () => {
  it('reads an active new subscription as a move off free', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.created', { items: items('starter'), status: 'active' }),
    )
    expect(moved).toEqual({ kind: 'switch', from: 'free', to: 'starter' })
  })

  it('ignores a subscription Checkout left incomplete, which grants no tier', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.created', { items: items('pro'), status: 'incomplete' }),
    )
    expect(moved).toBeNull()
  })

  it('reads the update that activates it as the acquisition', () => {
    const moved = planMovementOfEvent(
      event(
        'customer.subscription.updated',
        { items: items('pro'), status: 'active' },
        { status: 'incomplete' },
      ),
    )
    expect(moved).toEqual({ kind: 'switch', from: 'free', to: 'pro' })
  })

  it('reads a swapped plan price as a switch between the two tiers', () => {
    const moved = planMovementOfEvent(
      event(
        'customer.subscription.updated',
        { items: items('scale'), status: 'active' },
        { items: items('pro') },
      ),
    )
    expect(moved).toEqual({ kind: 'switch', from: 'pro', to: 'scale' })
  })

  it('reads a lapsed subscription as a move back to free', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.updated', { items: items('pro'), status: 'past_due' }, { status: 'active' }),
    )
    expect(moved).toEqual({ kind: 'switch', from: 'pro', to: 'free' })
  })

  it('reads cancel_at_period_end turning on as a scheduled cancellation', () => {
    const moved = planMovementOfEvent(
      event(
        'customer.subscription.updated',
        { items: items('starter'), status: 'active', cancel_at_period_end: true },
        { cancel_at_period_end: false },
      ),
    )
    expect(moved).toEqual({ kind: 'cancelScheduled', plan: 'starter' })
  })

  it('reads taking that cancellation back as its own move', () => {
    const moved = planMovementOfEvent(
      event(
        'customer.subscription.updated',
        { items: items('starter'), status: 'active', cancel_at_period_end: false },
        { cancel_at_period_end: true },
      ),
    )
    expect(moved).toEqual({ kind: 'cancelReverted', plan: 'starter' })
  })

  it('reads a deleted subscription as a cancellation of its tier', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.deleted', { items: items('pro'), status: 'canceled' }),
    )
    expect(moved).toEqual({ kind: 'canceled', plan: 'pro' })
  })

  it('ignores an incomplete subscription expiring, which had no tier to lose', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.deleted', { items: items('pro'), status: 'incomplete_expired' }),
    )
    expect(moved).toBeNull()
  })

  it('ignores a renewal, which moves the period and nothing else', () => {
    const moved = planMovementOfEvent(
      event(
        'customer.subscription.updated',
        { items: items('pro'), status: 'active' },
        { current_period_start: 1758000000 },
      ),
    )
    expect(moved).toBeNull()
  })

  it('ignores an item change that stays on the same tier', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.updated', { items: items('pro'), status: 'active' }, { items: items('pro') }),
    )
    expect(moved).toBeNull()
  })

  it('ignores a subscription with no LeadAce plan price', () => {
    const moved = planMovementOfEvent(
      event('customer.subscription.created', { items: items(), status: 'active' }),
    )
    expect(moved).toBeNull()
  })
})
