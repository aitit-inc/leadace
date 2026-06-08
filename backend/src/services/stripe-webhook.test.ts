import { describe, it, expect } from 'vitest'
import { planFromMetadata, effectivePlanFromStatus, verifyStripeSignature } from './stripe-webhook'

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
