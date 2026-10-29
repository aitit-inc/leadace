import { describe, it, expect } from 'vitest'
import { readStripeAnswer, shouldRetryStripe, stripeOutcome } from './stripe-api'

describe('stripeOutcome', () => {
  it('reads 2xx as applied and other 4xx as refused', () => {
    expect(stripeOutcome(200)).toBe('ok')
    expect(stripeOutcome(402)).toBe('failed')
    expect(stripeOutcome(404)).toBe('failed')
    expect(stripeOutcome(429)).toBe('failed')
  })
  it('reads no answer, a conflict and a server error as unknown', () => {
    expect(stripeOutcome(null)).toBe('unknown')
    expect(stripeOutcome(409)).toBe('unknown')
    expect(stripeOutcome(500)).toBe('unknown')
    expect(stripeOutcome(503)).toBe('unknown')
  })
})

describe('shouldRetryStripe', () => {
  it('retries an unknown outcome unless Stripe says not to', () => {
    expect(shouldRetryStripe('unknown', null)).toBe(true)
    expect(shouldRetryStripe('unknown', 'false')).toBe(false)
  })
  it('retries a refusal only when Stripe says to', () => {
    expect(shouldRetryStripe('failed', null)).toBe(false)
    expect(shouldRetryStripe('failed', 'true')).toBe(true)
    expect(shouldRetryStripe('ok', null)).toBe(false)
  })
})

describe('readStripeAnswer', () => {
  const outcome = (httpStatus: number | null, body: unknown) => stripeOutcome(readStripeAnswer(httpStatus, body).status)
  it('trusts a status only with a JSON object body', () => {
    expect(readStripeAnswer(200, { id: 'cus_1' })).toEqual({ status: 200, data: { id: 'cus_1' } })
    expect(outcome(402, { error: { type: 'card_error' } })).toBe('failed')
  })
  it('reads a 200 whose body is not JSON or not an object as unknown', () => {
    expect(readStripeAnswer(200, null)).toEqual({ status: null, data: null })
    expect(outcome(200, null)).toBe('unknown')
    expect(outcome(200, 'ok')).toBe('unknown')
    expect(outcome(200, 42)).toBe('unknown')
  })
  it('reads no answer as unknown', () => {
    expect(outcome(null, null)).toBe('unknown')
  })
})
