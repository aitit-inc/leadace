import { describe, it, expect } from 'vitest'
import {
  getPlanLimits,
  canRegisterMailbox,
  buildProspectQuota,
  isContactQuotaExhausted,
  isFoundQuotaExhausted,
  discoveryPausedReason,
  formatContactQuotaError,
  formatFoundQuotaError,
  isChatQuotaExhausted,
  formatChatQuotaError,
  type ProspectQuota,
  type InquiryChatQuota,
} from './plan-limits'

const capped = (over: Partial<Extract<ProspectQuota, { kind: 'capped' }>>): ProspectQuota => ({
  plan: 'starter',
  kind: 'capped',
  window: 'monthly',
  overageEnabled: false,
  contacted: { used: 0, limit: 100, remaining: 100 },
  found: { used: 0, limit: 100, remaining: 100 },
  ...over,
})

describe('getPlanLimits', () => {
  it('meters free over the tenant lifetime and keeps its storage cap', () => {
    expect(getPlanLimits('free')).toEqual({
      maxProjects: 1,
      prospectCaps: { window: 'lifetime', contacted: 30, found: 30 },
      maxProspects: 500,
      maxSendingIdentities: 1,
    })
  })

  it('meters paid plans per billing period and leaves only the internal tier unmetered', () => {
    expect(getPlanLimits('pro').prospectCaps).toEqual({ window: 'monthly', contacted: 300, found: 300 })
    expect(getPlanLimits('pro').maxProjects).toBe(5)
    expect(getPlanLimits('scale').prospectCaps).toEqual({ window: 'monthly', contacted: 800, found: 800 })
    expect(getPlanLimits('unlimited')).toEqual({
      maxProjects: null, prospectCaps: null, maxProspects: null, maxSendingIdentities: null,
    })
  })
})

describe('canRegisterMailbox', () => {
  it('blocks free regardless of count (paid feature)', () => {
    expect(canRegisterMailbox('free', 0)?.code).toBe('FORBIDDEN')
  })

  it('allows a paid plan below its cap (gmail counts toward the total)', () => {
    // pro cap = 3; with 1 existing (the connected gmail) a first smtp is allowed.
    expect(canRegisterMailbox('pro', 1)).toBeNull()
  })

  it('blocks a paid plan at its cap', () => {
    expect(canRegisterMailbox('starter', 1)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('pro', 3)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('scale', 10)?.code).toBe('FORBIDDEN')
  })

  it('never caps the internal unlimited tier (self-host)', () => {
    expect(canRegisterMailbox('unlimited', 99)).toBeNull()
  })
})

describe('buildProspectQuota', () => {
  it('clamps remaining at 0 when used exceeds the limit', () => {
    const q = buildProspectQuota('free', { window: 'lifetime', contacted: 30, found: 30 }, false, { contacted: 33, found: 2 })
    expect(q).toMatchObject({
      kind: 'capped',
      window: 'lifetime',
      contacted: { used: 33, limit: 30, remaining: 0 },
      found: { used: 2, limit: 30, remaining: 28 },
    })
  })
})

describe('exhaustion', () => {
  it('is per allowance and only when nothing remains', () => {
    expect(isContactQuotaExhausted(capped({ contacted: { used: 100, limit: 100, remaining: 0 } }))).toBe(true)
    expect(isFoundQuotaExhausted(capped({ contacted: { used: 100, limit: 100, remaining: 0 } }))).toBe(false)
    expect(isContactQuotaExhausted(capped({ contacted: { used: 99, limit: 100, remaining: 1 } }))).toBe(false)
    expect(isContactQuotaExhausted({ plan: 'unlimited', kind: 'unlimited' })).toBe(false)
  })

  it('never exhausts while overage is metered', () => {
    const q = capped({ overageEnabled: true, contacted: { used: 120, limit: 100, remaining: 0 }, found: { used: 101, limit: 100, remaining: 0 } })
    expect(isContactQuotaExhausted(q)).toBe(false)
    expect(isFoundQuotaExhausted(q)).toBe(false)
    expect(discoveryPausedReason(q)).toBeNull()
  })
})

describe('discoveryPausedReason', () => {
  it('pauses on a spent found allowance, and on a spent contact allowance', () => {
    expect(discoveryPausedReason(capped({ found: { used: 100, limit: 100, remaining: 0 } }))).toContain('find 100 prospects')
    expect(discoveryPausedReason(capped({ contacted: { used: 100, limit: 100, remaining: 0 } }))).toContain('Discovery is paused')
    expect(discoveryPausedReason(capped({}))).toBeNull()
  })
})

describe('quota messages', () => {
  it('phrase the window and keep follow-ups explicitly free', () => {
    const lifetime = capped({ plan: 'free', window: 'lifetime', contacted: { used: 30, limit: 30, remaining: 0 } })
    expect(formatContactQuotaError(lifetime)).toContain('30 prospects in total')
    expect(formatContactQuotaError(lifetime)).toContain('Follow-ups still go out')
    expect(formatContactQuotaError(capped({}))).toContain('per billing period')
    expect(formatFoundQuotaError(capped({}))).toContain('find 100 prospects per billing period')
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
