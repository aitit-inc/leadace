import { describe, it, expect } from 'vitest'
import {
  assertPlanPrice,
  planFromSubscriptionItems,
  periodFromSubscription,
  effectivePlanFromStatus,
  isInFinalPhase,
  rankLiveSubscriptions,
  verifyStripeSignature,
  type StripeSubscriptionItems,
} from './stripe-webhook'

// Timestamps stay relative to the real clock so the tolerance branch is
// deterministic without injecting one.
const SECRET = 'whsec_test'
const nowSec = () => Math.floor(Date.now() / 1000)
async function v1Hex(payload: string, ts: number, secret = SECRET): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${payload}`))
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

describe('verifyStripeSignature', () => {
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}'

  it('accepts a correctly-signed, in-tolerance payload', async () => {
    const ts = nowSec()
    const header = `t=${ts},v1=${await v1Hex(payload, ts)}`
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true)
  })

  it('accepts when one of several v1 signatures matches', async () => {
    const ts = nowSec()
    const header = `t=${ts},v1=deadbeef,v1=${await v1Hex(payload, ts)}`
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(true)
  })

  it('rejects a tampered payload (signature over different bytes)', async () => {
    const ts = nowSec()
    const header = `t=${ts},v1=${await v1Hex(payload, ts)}`
    expect(await verifyStripeSignature(`${payload} `, header, SECRET)).toBe(false)
  })

  it('rejects a tampered signature of the same length', async () => {
    const ts = nowSec()
    const good = await v1Hex(payload, ts)
    const flipped = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0')
    expect(await verifyStripeSignature(payload, `t=${ts},v1=${flipped}`, SECRET)).toBe(false)
  })

  it('rejects the wrong secret', async () => {
    const ts = nowSec()
    const header = `t=${ts},v1=${await v1Hex(payload, ts, 'whsec_other')}`
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false)
  })

  it('rejects a missing timestamp or missing v1', async () => {
    const ts = nowSec()
    const hex = await v1Hex(payload, ts)
    expect(await verifyStripeSignature(payload, `v1=${hex}`, SECRET)).toBe(false)
    expect(await verifyStripeSignature(payload, `t=${ts}`, SECRET)).toBe(false)
    expect(await verifyStripeSignature(payload, '', SECRET)).toBe(false)
  })

  it('rejects a timestamp outside the tolerance window (replay)', async () => {
    const staleTs = nowSec() - 10_000
    const header = `t=${staleTs},v1=${await v1Hex(payload, staleTs)}`
    expect(await verifyStripeSignature(payload, header, SECRET)).toBe(false)
  })
})

describe('planFromSubscriptionItems', () => {
  it('finds the plan price when it is not the first item', () => {
    const items: StripeSubscriptionItems = {
      data: [{ price: { metadata: {} } }, { price: { metadata: { plan: 'pro' } } }],
    }
    expect(planFromSubscriptionItems(items)).toBe('pro')
  })

  it('returns null when no item carries plan metadata', () => {
    expect(planFromSubscriptionItems({ data: [{ price: { metadata: {} } }] })).toBeNull()
    expect(planFromSubscriptionItems(undefined)).toBeNull()
  })
})

describe('periodFromSubscription', () => {
  const items: StripeSubscriptionItems = {
    data: [{ price: { metadata: {} } }, { price: { metadata: { plan: 'pro' } }, current_period_start: 10, current_period_end: 20 }],
  }

  it('reads the period from the subscription root when present', () => {
    expect(periodFromSubscription({ current_period_start: 1, current_period_end: 2 }, items)).toEqual({ start: 1, end: 2 })
  })

  it('falls back to the plan item when the root carries no period (Basil)', () => {
    expect(periodFromSubscription({}, items)).toEqual({ start: 10, end: 20 })
  })

  it('answers undefined when neither carries one', () => {
    expect(periodFromSubscription({}, { data: [{ price: { metadata: { plan: 'pro' } } }] })).toEqual({ start: undefined, end: undefined })
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

describe('isInFinalPhase', () => {
  const phases = [{ start_date: 100 }, { start_date: 200 }]
  it('is true once the last phase is the current one', () => {
    expect(isInFinalPhase({ current_phase: { start_date: 200 }, phases })).toBe(true)
  })
  it('is false while an earlier phase runs', () => {
    expect(isInFinalPhase({ current_phase: { start_date: 100 }, phases })).toBe(false)
  })
  it('is false for a single-phase schedule and without a current phase', () => {
    expect(isInFinalPhase({ current_phase: { start_date: 100 }, phases: [{ start_date: 100 }] })).toBe(false)
    expect(isInFinalPhase({ current_phase: null, phases })).toBe(false)
  })
})

describe('rankLiveSubscriptions', () => {
  const ids = (subs: Array<Record<string, unknown>>) => rankLiveSubscriptions(subs).map((sub) => sub['id'])
  it('drops ended subscriptions and keeps unpaid ones', () => {
    expect(ids([
      { id: 'canceled', status: 'canceled', created: 3 },
      { id: 'expired', status: 'incomplete_expired', created: 2 },
      { id: 'past_due', status: 'past_due', created: 1 },
    ])).toEqual(['past_due'])
    expect(ids([{ id: 'canceled', status: 'canceled', created: 1 }])).toEqual([])
  })
  it('puts a paying subscription before an unpaid newer one', () => {
    expect(ids([
      { id: 'unpaid', status: 'unpaid', created: 5 },
      { id: 'active', status: 'active', created: 1 },
    ])).toEqual(['active', 'unpaid'])
  })
  it('keeps paused and trialing as live, trialing as paying', () => {
    expect(ids([
      { id: 'paused', status: 'paused', created: 3 },
      { id: 'trialing', status: 'trialing', created: 1 },
    ])).toEqual(['trialing', 'paused'])
  })
  it('puts the newest first among equals', () => {
    expect(ids([
      { id: 'old', status: 'active', created: 1 },
      { id: 'new', status: 'trialing', created: 2 },
    ])).toEqual(['new', 'old'])
  })
})

describe('assertPlanPrice', () => {
  const context = { tenantId: 't', subscriptionId: 'sub', items: undefined }
  it('throws for a paying subscription on a price without plan metadata', () => {
    expect(() => assertPlanPrice('active', null, context)).toThrow()
    expect(() => assertPlanPrice('trialing', null, context)).toThrow()
  })
  it('lets an unpaid subscription without a plan through (it mirrors as free)', () => {
    expect(() => assertPlanPrice('past_due', null, context)).not.toThrow()
    expect(() => assertPlanPrice('incomplete', null, context)).not.toThrow()
    expect(() => assertPlanPrice('unpaid', null, context)).not.toThrow()
  })
  it('lets a subscription with a plan through', () => {
    expect(() => assertPlanPrice('active', 'pro', context)).not.toThrow()
  })
})
