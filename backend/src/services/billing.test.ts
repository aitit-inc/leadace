import { describe, it, expect } from 'vitest'
import { customerSubscriptions } from './billing'

const list = (...statuses: string[]) => ({ ok: true, data: { data: statuses.map((status) => ({ status })) } })

describe('customerSubscriptions', () => {
  it('counts a lapsed or still-paying subscription as live', () => {
    expect(customerSubscriptions(list('active'))).toBe('live')
    expect(customerSubscriptions(list('past_due'))).toBe('live')
    expect(customerSubscriptions(list('unpaid'))).toBe('live')
    expect(customerSubscriptions(list('incomplete'))).toBe('live')
    expect(customerSubscriptions(list('canceled', 'active'))).toBe('live')
    expect(customerSubscriptions(list('trialing'))).toBe('live')
    expect(customerSubscriptions(list('paused'))).toBe('live')
  })

  it('finds none when every subscription has ended', () => {
    expect(customerSubscriptions(list())).toBe('none')
    expect(customerSubscriptions(list('canceled', 'incomplete_expired'))).toBe('none')
  })

  it('cannot tell when Stripe fails the read', () => {
    expect(customerSubscriptions({ ok: false, data: { error: { code: 'resource_missing' } } })).toBe('unreadable')
    expect(customerSubscriptions({ ok: true, data: {} })).toBe('unreadable')
  })
})
