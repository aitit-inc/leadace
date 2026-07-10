import {
  OUTBOUND_CHANNELS,
  REACHABLE_STATUSES,
  type OutboundChannel,
  type Priority,
  type ProspectStatus,
} from '../db/schema'
import { isAllowedSendCountry } from './country'

export type ReachableArm = 'first_or_deferred' | 'short_cycle_followup' | 'no_response_recycle'

const dueNullable = (d: Date | null, now: Date): boolean => d === null || d.getTime() <= now.getTime()
const duePresent = (d: Date | null, now: Date): boolean => d !== null && d.getTime() <= now.getTime()

export function reachabilityArm(
  status: ProspectStatus,
  nextOutreachAfter: Date | null,
  nextFollowupAfter: Date | null,
  now: Date,
): ReachableArm | null {
  if (REACHABLE_STATUSES.includes(status)) {
    return dueNullable(nextOutreachAfter, now) ? 'first_or_deferred' : null
  }
  if (status === 'contacted') {
    if (nextFollowupAfter !== null) {
      return duePresent(nextFollowupAfter, now) ? 'short_cycle_followup' : null
    }
    return duePresent(nextOutreachAfter, now) ? 'no_response_recycle' : null
  }
  return null
}

export type CandidateChannels = {
  readonly email: boolean
  readonly form: boolean
  readonly sns_twitter: boolean
  readonly sns_linkedin: boolean
}

export interface SendCandidate {
  readonly status: ProspectStatus
  readonly priority: Priority
  readonly projectProspectCreatedAt: Date
  readonly doNotContact: boolean
  readonly channels: CandidateChannels
  readonly effectiveCountry: string | null
  readonly nextOutreachAfter: Date | null
  readonly nextFollowupAfter: Date | null
  readonly hasFreshSignal: boolean
  readonly hasOpenOutreach: boolean
}

export interface SendEnvironment {
  readonly enabledChannels: ReadonlySet<OutboundChannel>
  readonly targetCountries: ReadonlySet<string>
}

export function usableChannels(c: SendCandidate, env: SendEnvironment): OutboundChannel[] {
  return OUTBOUND_CHANNELS.filter((ch) => env.enabledChannels.has(ch) && c.channels[ch])
}

export type IneligibleReason =
  | 'do_not_contact'
  | 'unsupported_country'
  | 'project_country_excluded'
  | 'no_reachable_channel'
  | 'unreachable_status'
  | 'not_reachable_now'
  | 'in_flight'

export type Eligibility =
  | { readonly eligible: true; readonly arm: ReachableArm }
  | { readonly eligible: false; readonly reason: IneligibleReason }

export function evaluateEligibility(c: SendCandidate, env: SendEnvironment, now: Date): Eligibility {
  if (c.doNotContact) return { eligible: false, reason: 'do_not_contact' }

  // Opposite null semantics: the always-on US/CA/JP allowlist warns-and-allows a
  // null country; the project's optional targetCountries excludes it.
  if (!isAllowedSendCountry(c.effectiveCountry).allowed) {
    return { eligible: false, reason: 'unsupported_country' }
  }
  if (
    env.targetCountries.size > 0 &&
    (c.effectiveCountry === null || !env.targetCountries.has(c.effectiveCountry))
  ) {
    return { eligible: false, reason: 'project_country_excluded' }
  }

  if (usableChannels(c, env).length === 0) return { eligible: false, reason: 'no_reachable_channel' }

  const arm = reachabilityArm(c.status, c.nextOutreachAfter, c.nextFollowupAfter, now)
  if (arm === null) {
    const statusCanReach = REACHABLE_STATUSES.includes(c.status) || c.status === 'contacted'
    return { eligible: false, reason: statusCanReach ? 'not_reachable_now' : 'unreachable_status' }
  }

  if (c.hasOpenOutreach) return { eligible: false, reason: 'in_flight' }
  return { eligible: true, arm }
}

const DAY_MS = 24 * 60 * 60 * 1000
export function isFreshSignal(
  signalsPresent: boolean,
  signalsUpdatedAt: Date | null,
  now: Date,
  freshDays: number,
): boolean {
  if (!signalsPresent || signalsUpdatedAt === null) return false
  return signalsUpdatedAt.getTime() >= now.getTime() - freshDays * DAY_MS
}

export type SendScore = { readonly __brand: 'SendScore'; readonly rank: number; readonly tieBreak: number }

export interface RankConfig {
  readonly freshSignalWeight: number
}

export const DEFAULT_RANK_CONFIG: RankConfig = { freshSignalWeight: 1 }

export function sendScore(c: SendCandidate, cfg: RankConfig): SendScore {
  const rank = c.priority + (c.hasFreshSignal ? 0 : cfg.freshSignalWeight)
  return { __brand: 'SendScore', rank, tieBreak: c.projectProspectCreatedAt.getTime() }
}

export function compareSendScore(a: SendScore, b: SendScore): number {
  return a.rank - b.rank || a.tieBreak - b.tieBreak
}

export type SendDecision =
  | { readonly send: false; readonly reason: IneligibleReason }
  | { readonly send: true; readonly arm: ReachableArm; readonly score: SendScore }

export function decideSend(c: SendCandidate, env: SendEnvironment, cfg: RankConfig, now: Date): SendDecision {
  const eligibility = evaluateEligibility(c, env, now)
  if (!eligibility.eligible) return { send: false, reason: eligibility.reason }
  return { send: true, arm: eligibility.arm, score: sendScore(c, cfg) }
}

export type OutreachBudget =
  | { readonly capped: false }
  | { readonly capped: true; readonly remaining: number }

export type RunBlockedReason = { readonly kind: 'quota_exhausted' } | { readonly kind: 'no_channels_enabled' }
export type RunGate = { readonly open: true } | { readonly open: false; readonly reason: RunBlockedReason }

export function evaluateRunGate(args: { budget: OutreachBudget; enabledChannelCount: number }): RunGate {
  if (args.budget.capped && args.budget.remaining <= 0) {
    return { open: false, reason: { kind: 'quota_exhausted' } }
  }
  if (args.enabledChannelCount === 0) {
    return { open: false, reason: { kind: 'no_channels_enabled' } }
  }
  return { open: true }
}

export function effectiveTargetCount(requested: number, budget: OutreachBudget): number {
  return budget.capped ? Math.min(requested, budget.remaining) : requested
}
