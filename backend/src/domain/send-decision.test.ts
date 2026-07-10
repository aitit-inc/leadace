import { describe, it, expect } from 'vitest'
import {
  reachabilityArm,
  evaluateEligibility,
  usableChannels,
  isFreshSignal,
  sendScore,
  compareSendScore,
  decideSend,
  evaluateRunGate,
  effectiveTargetCount,
  DEFAULT_RANK_CONFIG,
  type SendCandidate,
  type SendEnvironment,
  type OutreachBudget,
} from './send-decision'
import type { OutboundChannel, Priority, ProspectStatus } from '../db/schema'

const NOW = new Date('2026-07-07T00:00:00Z')
const past = new Date('2026-07-06T00:00:00Z')
const future = new Date('2026-07-08T00:00:00Z')

const allChannels = (): SendCandidate['channels'] => ({
  email: true,
  form: false,
  sns_twitter: false,
  sns_linkedin: false,
})

function candidate(over: Partial<SendCandidate> = {}): SendCandidate {
  return {
    status: 'new',
    priority: 3 as Priority,
    projectProspectCreatedAt: new Date('2026-01-01T00:00:00Z'),
    doNotContact: false,
    channels: allChannels(),
    effectiveCountry: 'US',
    nextOutreachAfter: null,
    nextFollowupAfter: null,
    hasFreshSignal: false,
    hasOpenOutreach: false,
    ...over,
  }
}

function env(over: Partial<SendEnvironment> = {}): SendEnvironment {
  return {
    enabledChannels: new Set<OutboundChannel>(['email', 'form', 'sns_twitter', 'sns_linkedin']),
    targetCountries: new Set<string>(),
    ...over,
  }
}

describe('reachabilityArm', () => {
  it('new with no window → first_or_deferred', () => {
    expect(reachabilityArm('new', null, null, NOW)).toBe('first_or_deferred')
  })
  it('new with passed next_outreach_after → first_or_deferred', () => {
    expect(reachabilityArm('new', past, null, NOW)).toBe('first_or_deferred')
  })
  it('new with future next_outreach_after → null', () => {
    expect(reachabilityArm('new', future, null, NOW)).toBeNull()
  })
  it('deferred behaves like new', () => {
    expect(reachabilityArm('deferred', null, null, NOW)).toBe('first_or_deferred')
  })
  it('contacted with due next_followup_after → short_cycle_followup', () => {
    expect(reachabilityArm('contacted', null, past, NOW)).toBe('short_cycle_followup')
  })
  it('contacted with future next_followup_after → null (sequence not yet due)', () => {
    expect(reachabilityArm('contacted', past, future, NOW)).toBeNull()
  })
  it('contacted, no followup in progress, due next_outreach_after → no_response_recycle', () => {
    expect(reachabilityArm('contacted', past, null, NOW)).toBe('no_response_recycle')
  })
  it('contacted, no followup, future recycle window → null', () => {
    expect(reachabilityArm('contacted', future, null, NOW)).toBeNull()
  })
  it('contacted, no followup, no recycle window → null', () => {
    expect(reachabilityArm('contacted', null, null, NOW)).toBeNull()
  })
  it('contacted with BOTH windows due → short_cycle_followup wins (never double-picks)', () => {
    expect(reachabilityArm('contacted', past, past, NOW)).toBe('short_cycle_followup')
  })
  it('boundary: next_followup_after exactly now is due (<=)', () => {
    expect(reachabilityArm('contacted', null, NOW, NOW)).toBe('short_cycle_followup')
  })
  it.each(['responded', 'converted', 'rejected', 'inactive'] as ProspectStatus[])(
    'terminal status %s → null',
    (status) => {
      expect(reachabilityArm(status, past, past, NOW)).toBeNull()
    },
  )
})

describe('usableChannels', () => {
  it('intersects presence with enabled channels', () => {
    const c = candidate({ channels: { email: true, form: true, sns_twitter: false, sns_linkedin: false } })
    expect(usableChannels(c, env({ enabledChannels: new Set(['email']) }))).toEqual(['email'])
  })
  it('present-but-not-enabled yields nothing', () => {
    const c = candidate({ channels: { email: false, form: true, sns_twitter: false, sns_linkedin: false } })
    expect(usableChannels(c, env({ enabledChannels: new Set(['email']) }))).toEqual([])
  })
})

describe('evaluateEligibility', () => {
  it('happy path → eligible with arm', () => {
    expect(evaluateEligibility(candidate(), env(), NOW)).toEqual({ eligible: true, arm: 'first_or_deferred' })
  })
  it('do_not_contact reported first even when other gates would also fail', () => {
    const c = candidate({ doNotContact: true, effectiveCountry: 'FR', status: 'rejected' })
    expect(evaluateEligibility(c, env(), NOW)).toEqual({ eligible: false, reason: 'do_not_contact' })
  })
  it('unsupported country (hard allowlist) → unsupported_country', () => {
    expect(evaluateEligibility(candidate({ effectiveCountry: 'FR' }), env(), NOW)).toEqual({
      eligible: false,
      reason: 'unsupported_country',
    })
  })
  it('null country passes the hard allowlist (warn-and-allow)', () => {
    expect(evaluateEligibility(candidate({ effectiveCountry: null }), env(), NOW)).toEqual({
      eligible: true,
      arm: 'first_or_deferred',
    })
  })
  it('lowercase country is normalized by the hard allowlist', () => {
    expect(evaluateEligibility(candidate({ effectiveCountry: 'us' }), env(), NOW).eligible).toBe(true)
  })
  it('project targetCountries excludes a non-member (case-sensitive, mirrors SQL IN)', () => {
    const e = env({ targetCountries: new Set(['JP']) })
    expect(evaluateEligibility(candidate({ effectiveCountry: 'US' }), e, NOW)).toEqual({
      eligible: false,
      reason: 'project_country_excluded',
    })
  })
  it('project targetCountries excludes null country', () => {
    const e = env({ targetCountries: new Set(['US']) })
    expect(evaluateEligibility(candidate({ effectiveCountry: null }), e, NOW)).toEqual({
      eligible: false,
      reason: 'project_country_excluded',
    })
  })
  it('no reachable channel → no_reachable_channel', () => {
    const c = candidate({ channels: { email: false, form: false, sns_twitter: false, sns_linkedin: false } })
    expect(evaluateEligibility(c, env(), NOW)).toEqual({ eligible: false, reason: 'no_reachable_channel' })
  })
  it('email channel unusable with only email enabled → no_reachable_channel', () => {
    const c = candidate({ channels: { email: false, form: true, sns_twitter: false, sns_linkedin: false } })
    expect(evaluateEligibility(c, env({ enabledChannels: new Set(['email']) }), NOW)).toEqual({
      eligible: false,
      reason: 'no_reachable_channel',
    })
  })
  it('terminal status → unreachable_status', () => {
    expect(evaluateEligibility(candidate({ status: 'rejected' }), env(), NOW)).toEqual({
      eligible: false,
      reason: 'unreachable_status',
    })
  })
  it('reachable status but not due → not_reachable_now', () => {
    expect(evaluateEligibility(candidate({ status: 'new', nextOutreachAfter: future }), env(), NOW)).toEqual({
      eligible: false,
      reason: 'not_reachable_now',
    })
  })
  it('in-flight outreach → in_flight', () => {
    expect(evaluateEligibility(candidate({ hasOpenOutreach: true }), env(), NOW)).toEqual({
      eligible: false,
      reason: 'in_flight',
    })
  })
})

describe('isFreshSignal', () => {
  it('present payload updated within window → true', () => {
    expect(isFreshSignal(true, new Date('2026-07-01T00:00:00Z'), NOW, 14)).toBe(true)
  })
  it('present payload older than window → false', () => {
    expect(isFreshSignal(true, new Date('2026-06-01T00:00:00Z'), NOW, 14)).toBe(false)
  })
  it('null payload → false even if timestamp is recent', () => {
    expect(isFreshSignal(false, past, NOW, 14)).toBe(false)
  })
  it('null timestamp → false', () => {
    expect(isFreshSignal(true, null, NOW, 14)).toBe(false)
  })
  it('boundary: exactly freshDays ago → true (>=)', () => {
    const boundary = new Date(NOW.getTime() - 14 * 24 * 60 * 60 * 1000)
    expect(isFreshSignal(true, boundary, NOW, 14)).toBe(true)
  })
})

describe('sendScore / compareSendScore', () => {
  const scoreOf = (over: Partial<SendCandidate>, weight = 1) =>
    sendScore(candidate(over), { freshSignalWeight: weight })

  it('fresh signal beats stale at the same priority (one notch)', () => {
    const fresh = scoreOf({ priority: 3 as Priority, hasFreshSignal: true })
    const stale = scoreOf({ priority: 3 as Priority, hasFreshSignal: false })
    expect(compareSendScore(fresh, stale)).toBeLessThan(0)
  })
  it('fresh signal is worth exactly one notch: p3-fresh ties p2-stale on rank, never beats p2-fresh', () => {
    const p3fresh = scoreOf({ priority: 3 as Priority, hasFreshSignal: true })
    const p2stale = scoreOf({ priority: 2 as Priority, hasFreshSignal: false })
    const p2fresh = scoreOf({ priority: 2 as Priority, hasFreshSignal: true })
    expect(p3fresh.rank).toBe(p2stale.rank)
    expect(compareSendScore(p3fresh, p2fresh)).toBeGreaterThan(0)
  })
  it('equal rank falls back to created_at, oldest first', () => {
    const older = sendScore(
      candidate({ priority: 3 as Priority, hasFreshSignal: false, projectProspectCreatedAt: new Date('2026-01-01T00:00:00Z') }),
      DEFAULT_RANK_CONFIG,
    )
    const newer = sendScore(
      candidate({ priority: 3 as Priority, hasFreshSignal: false, projectProspectCreatedAt: new Date('2026-02-01T00:00:00Z') }),
      DEFAULT_RANK_CONFIG,
    )
    expect(compareSendScore(older, newer)).toBeLessThan(0)
  })
  it('weight 0 removes the fresh bump', () => {
    const fresh = scoreOf({ priority: 3 as Priority, hasFreshSignal: true, projectProspectCreatedAt: new Date('2026-01-01T00:00:00Z') }, 0)
    const stale = scoreOf({ priority: 3 as Priority, hasFreshSignal: false, projectProspectCreatedAt: new Date('2026-01-01T00:00:00Z') }, 0)
    expect(compareSendScore(fresh, stale)).toBe(0)
  })
})

describe('decideSend', () => {
  it('ineligible → send:false with reason', () => {
    expect(decideSend(candidate({ doNotContact: true }), env(), DEFAULT_RANK_CONFIG, NOW)).toEqual({
      send: false,
      reason: 'do_not_contact',
    })
  })
  it('eligible → send:true with arm and score', () => {
    const d = decideSend(candidate(), env(), DEFAULT_RANK_CONFIG, NOW)
    expect(d.send).toBe(true)
    if (d.send) {
      expect(d.arm).toBe('first_or_deferred')
      expect(d.score.rank).toBe(4)
    }
  })
})

describe('evaluateRunGate', () => {
  const capped = (remaining: number): OutreachBudget => ({ capped: true, remaining })
  const unlimited: OutreachBudget = { capped: false }

  it('capped with 0 remaining → quota_exhausted', () => {
    expect(evaluateRunGate({ budget: capped(0), enabledChannelCount: 2 })).toEqual({
      open: false,
      reason: { kind: 'quota_exhausted' },
    })
  })
  it('capped with remaining and channels → open', () => {
    expect(evaluateRunGate({ budget: capped(5), enabledChannelCount: 2 })).toEqual({ open: true })
  })
  it('no channels → no_channels_enabled', () => {
    expect(evaluateRunGate({ budget: unlimited, enabledChannelCount: 0 })).toEqual({
      open: false,
      reason: { kind: 'no_channels_enabled' },
    })
  })
  it('quota checked before channels', () => {
    expect(evaluateRunGate({ budget: capped(0), enabledChannelCount: 0 })).toEqual({
      open: false,
      reason: { kind: 'quota_exhausted' },
    })
  })
})

describe('effectiveTargetCount', () => {
  it('unlimited → requested unchanged', () => {
    expect(effectiveTargetCount(10, { capped: false })).toBe(10)
  })
  it('capped binds to remaining when smaller', () => {
    expect(effectiveTargetCount(10, { capped: true, remaining: 5 })).toBe(5)
  })
  it('capped leaves requested when remaining is larger', () => {
    expect(effectiveTargetCount(10, { capped: true, remaining: 20 })).toBe(10)
  })
  it('capped at 0 → 0', () => {
    expect(effectiveTargetCount(10, { capped: true, remaining: 0 })).toBe(0)
  })
})
