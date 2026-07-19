import { describe, it, expect } from 'vitest'
import {
  getPlanLimits,
  canRegisterSmtpIdentity,
  selectOutreachQuota,
  isOutreachQuotaExhausted,
  outreachQuotaErrorIfExhausted,
  formatOutreachQuotaError,
  isChatQuotaExhausted,
  formatChatQuotaError,
  type OutreachQuota,
  type InquiryChatQuota,
} from './plan-limits'

const cappedOutreach = (over: Partial<Extract<OutreachQuota, { kind: 'capped' }>>): OutreachQuota => ({
  plan: 'free',
  kind: 'capped',
  used: 0,
  limit: 5,
  remaining: 5,
  bindingConstraint: 'daily',
  ...over,
})

describe('getPlanLimits', () => {
  it('encodes the Free dual cap (daily + lifetime) and prospect cap', () => {
    expect(getPlanLimits('free')).toEqual({
      maxProjects: 1, maxOutreachPerDay: 5, maxOutreachLifetime: 100, maxOutreachPerMonth: null, maxProspects: 500, maxSendingIdentities: 1,
    })
  })

  it('encodes paid monthly caps and unlimited tiers', () => {
    expect(getPlanLimits('pro').maxOutreachPerMonth).toBe(4000)
    expect(getPlanLimits('pro').maxProjects).toBe(5)
    expect(getPlanLimits('scale')).toEqual({
      maxProjects: null, maxOutreachPerDay: null, maxOutreachLifetime: null, maxOutreachPerMonth: null, maxProspects: null, maxSendingIdentities: null,
    })
  })
})

describe('canRegisterSmtpIdentity', () => {
  it('blocks free regardless of count (paid feature)', () => {
    expect(canRegisterSmtpIdentity('free', 0)?.code).toBe('FORBIDDEN')
  })

  it('allows a paid plan below its cap (gmail counts toward the total)', () => {
    // starter cap = 2; with 1 existing (the connected gmail) a first smtp is allowed.
    expect(canRegisterSmtpIdentity('starter', 1)).toBeNull()
  })

  it('blocks a paid plan at its cap', () => {
    expect(canRegisterSmtpIdentity('starter', 2)?.code).toBe('FORBIDDEN')
    expect(canRegisterSmtpIdentity('pro', 5)?.code).toBe('FORBIDDEN')
  })

  it('never caps unlimited tiers (scale / self-host)', () => {
    expect(canRegisterSmtpIdentity('scale', 99)).toBeNull()
    expect(canRegisterSmtpIdentity('unlimited', 99)).toBeNull()
  })
})

describe('isOutreachQuotaExhausted', () => {
  it('is true only when a capped quota has no remaining', () => {
    expect(isOutreachQuotaExhausted(cappedOutreach({ remaining: 0 }))).toBe(true)
    expect(isOutreachQuotaExhausted(cappedOutreach({ remaining: 3 }))).toBe(false)
    expect(isOutreachQuotaExhausted({ plan: 'scale', kind: 'unlimited', used: 999 })).toBe(false)
  })
})

describe('outreachQuotaErrorIfExhausted', () => {
  it('returns a FORBIDDEN error when exhausted, null otherwise', () => {
    const err = outreachQuotaErrorIfExhausted(cappedOutreach({ remaining: 0 }))
    expect(err?.code).toBe('FORBIDDEN')
    expect(outreachQuotaErrorIfExhausted(cappedOutreach({ remaining: 1 }))).toBeNull()
  })
})

describe('formatOutreachQuotaError', () => {
  it('phrases the message per binding constraint', () => {
    expect(formatOutreachQuotaError(cappedOutreach({ bindingConstraint: 'daily' }))).toContain('tomorrow')
    expect(formatOutreachQuotaError(cappedOutreach({ bindingConstraint: 'lifetime' }))).toContain('lifetime')
    expect(formatOutreachQuotaError(cappedOutreach({ bindingConstraint: 'monthly' }))).toContain('this month')
  })
})

describe('selectOutreachQuota', () => {
  it('returns unlimited when no windows apply', () => {
    expect(selectOutreachQuota('scale', [])).toEqual({ plan: 'scale', kind: 'unlimited', used: 0 })
  })

  it('clamps remaining at 0 when used exceeds the limit', () => {
    const q = selectOutreachQuota('free', [{ kind: 'daily', limit: 5, used: 7 }])
    expect(q).toMatchObject({ kind: 'capped', bindingConstraint: 'daily', remaining: 0, used: 7, limit: 5 })
  })

  it('binds to the window with the least remaining', () => {
    const q = selectOutreachQuota('free', [
      { kind: 'daily', limit: 5, used: 3 },      // remaining 2
      { kind: 'lifetime', limit: 50, used: 5 },  // remaining 45
    ])
    expect(q).toMatchObject({ kind: 'capped', bindingConstraint: 'daily', remaining: 2 })
  })

  it('breaks remaining ties toward the most terminal window (lifetime > monthly > daily)', () => {
    const q = selectOutreachQuota('free', [
      { kind: 'daily', limit: 10, used: 5 },     // remaining 5
      { kind: 'lifetime', limit: 50, used: 45 }, // remaining 5
    ])
    expect(q).toMatchObject({ kind: 'capped', bindingConstraint: 'lifetime', remaining: 5 })
  })

  it('exposes a per-window breakdown', () => {
    const q = selectOutreachQuota('free', [
      { kind: 'daily', limit: 5, used: 1 },
      { kind: 'lifetime', limit: 50, used: 10 },
    ])
    if (q.kind !== 'capped') throw new Error('expected capped')
    expect(q.daily).toEqual({ used: 1, limit: 5, remaining: 4 })
    expect(q.lifetime).toEqual({ used: 10, limit: 50, remaining: 40 })
    expect(q.monthly).toBeUndefined()
  })
})

describe('inquiry chat quota helpers', () => {
  const cappedChat = (over: Partial<Extract<InquiryChatQuota, { kind: 'capped' }>>): InquiryChatQuota => ({
    plan: 'free', kind: 'capped', used: 0, limit: 25, remaining: 25, bindingConstraint: 'lifetime', ...over,
  })

  it('detects exhaustion and phrases per binding constraint', () => {
    expect(isChatQuotaExhausted(cappedChat({ remaining: 0 }))).toBe(true)
    expect(isChatQuotaExhausted(cappedChat({ remaining: 1 }))).toBe(false)
    expect(formatChatQuotaError(cappedChat({ bindingConstraint: 'lifetime' }))).toContain('lifetime')
    expect(formatChatQuotaError(cappedChat({ bindingConstraint: 'monthly' }))).toContain('per month')
  })
})
