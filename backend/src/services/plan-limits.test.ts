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
  mainChatWindow,
  buildMainChatQuota,
  planFromMetadata,
  type ProspectQuota,
  type InquiryChatQuota,
} from './plan-limits'

const capped = (over: Partial<Extract<ProspectQuota, { kind: 'capped' }>>): ProspectQuota => ({
  plan: 'starter',
  kind: 'capped',
  window: 'monthly',
  credits: { balanceCents: 0, autoTopUp: { enabled: false, amountCents: 2500, thresholdCents: 500, failedAt: null } },
  contacted: { used: 0, limit: 100, remaining: 100 },
  found: { used: 0, limit: 100, remaining: 100 },
  ...over,
})

describe('getPlanLimits', () => {
  it('meters free over the tenant lifetime and keeps its storage cap', () => {
    expect(getPlanLimits('free')).toEqual({
      maxProjects: 1,
      prospectCaps: { window: 'lifetime', contacted: 50, found: 50 },
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
    expect(canRegisterMailbox('free', 0, false)?.code).toBe('FORBIDDEN')
  })

  it('allows a paid plan below its cap (gmail counts toward the total)', () => {
    // pro cap = 3; with 1 existing (the connected gmail) a first smtp is allowed.
    expect(canRegisterMailbox('pro', 1, true)).toBeNull()
  })

  it('keeps the slot of a sign-in gmail not connected yet', () => {
    expect(canRegisterMailbox('starter', 0, false)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('pro', 2, false)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('pro', 1, false)).toBeNull()
  })

  it('blocks a paid plan at its cap', () => {
    expect(canRegisterMailbox('starter', 1, true)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('pro', 3, true)?.code).toBe('FORBIDDEN')
    expect(canRegisterMailbox('scale', 10, true)?.code).toBe('FORBIDDEN')
  })

  it('never caps the internal unlimited tier (self-host)', () => {
    expect(canRegisterMailbox('unlimited', 99, true)).toBeNull()
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

describe('buildProspectQuota', () => {
  it('clamps remaining at 0 when used exceeds the limit', () => {
    const q = buildProspectQuota('free', { window: 'lifetime', contacted: 30, found: 30 }, null, { contacted: 33, found: 2 })
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

  it('never exhausts while the balance pays for the next unit', () => {
    const past = { contacted: { used: 120, limit: 100, remaining: 0 }, found: { used: 101, limit: 100, remaining: 0 } }
    const q = capped({ ...past, credits: { balanceCents: 60, autoTopUp: { enabled: false, amountCents: 2500, thresholdCents: 500, failedAt: null } } })
    expect(isContactQuotaExhausted(q)).toBe(false)
    expect(isFoundQuotaExhausted(q)).toBe(false)
    expect(discoveryPausedReason(q)).toBeNull()
  })

  it('exhausts per unit price once the balance is below it, auto top-up or not', () => {
    const past = { contacted: { used: 120, limit: 100, remaining: 0 }, found: { used: 101, limit: 100, remaining: 0 } }
    const forty = capped({ ...past, credits: { balanceCents: 40, autoTopUp: { enabled: true, amountCents: 2500, thresholdCents: 500, failedAt: null } } })
    expect(isContactQuotaExhausted(forty)).toBe(false)
    expect(isFoundQuotaExhausted(forty)).toBe(true)
    const spent = capped({ ...past, credits: { balanceCents: 39, autoTopUp: { enabled: true, amountCents: 2500, thresholdCents: 500, failedAt: null } } })
    expect(isContactQuotaExhausted(spent)).toBe(true)
    expect(isContactQuotaExhausted(capped({ ...past, plan: 'free', window: 'lifetime', credits: null }))).toBe(true)
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
    const lifetime = capped({ plan: 'free', window: 'lifetime', contacted: { used: 50, limit: 50, remaining: 0 } })
    expect(formatContactQuotaError(lifetime)).toContain('50 prospects in total')
    expect(formatContactQuotaError(lifetime)).toContain('Follow-ups still go out')
    expect(formatContactQuotaError(capped({}))).toContain('per billing period')
    expect(formatFoundQuotaError(capped({}))).toContain('find 100 prospects per billing period')
  })
})

describe('inquiry chat quota helpers', () => {
  const cappedChat = (over: Partial<Extract<InquiryChatQuota, { kind: 'capped' }>>): InquiryChatQuota => ({
    plan: 'free', kind: 'capped', used: 0, limit: 25, remaining: 25, bindingConstraint: 'lifetime', ...over,
  })

  it('detects exhaustion', () => {
    expect(isChatQuotaExhausted(cappedChat({ remaining: 0 }))).toBe(true)
    expect(isChatQuotaExhausted(cappedChat({ remaining: 1 }))).toBe(false)
  })
})

describe('main chat allowance', () => {
  const periodStart = new Date('2026-10-05T10:00:00Z')

  it('counts free over the tenant lifetime and paid plans from the period start', () => {
    expect(mainChatWindow({ plan: 'free', currentPeriodStart: null })).toEqual({ window: 'lifetime', messages: 60, start: new Date(0) })
    expect(mainChatWindow({ plan: 'starter', currentPeriodStart: periodStart })).toEqual({ window: 'monthly', messages: 150, start: periodStart })
    expect(mainChatWindow({ plan: 'pro', currentPeriodStart: periodStart })?.messages).toBe(300)
    expect(mainChatWindow({ plan: 'scale', currentPeriodStart: periodStart })?.messages).toBe(600)
  })

  it('has nothing to count against on the unlimited tier or a paid row without a period', () => {
    expect(mainChatWindow({ plan: 'unlimited', currentPeriodStart: periodStart })).toBeNull()
    expect(mainChatWindow({ plan: 'starter', currentPeriodStart: null })).toBeNull()
  })

  it('counts down to 0 and never below', () => {
    const free = { window: 'lifetime', messages: 60, start: new Date(0) } as const
    expect(buildMainChatQuota(free, 59)).toEqual({ kind: 'capped', window: 'lifetime', used: 59, limit: 60, remaining: 1 })
    expect(buildMainChatQuota(free, 60)).toMatchObject({ remaining: 0 })
    expect(buildMainChatQuota(free, 75)).toMatchObject({ used: 75, remaining: 0 })
  })
})
