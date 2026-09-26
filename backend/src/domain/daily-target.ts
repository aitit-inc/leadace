import { MAX_DISCOVERY_PASSES, type CycleStop } from './cycle-plan'

// The Free allowance is 30 for the account's lifetime: 5 a day shows replies
// within days without spending it all on day one.
export const FREE_DAILY_PACE = 5
// Only for a plan that sets no pace (unlimited, self-host).
export const FALLBACK_DAILY_TARGET = 20

export type PaceInput =
  | { kind: 'unlimited' }
  | { kind: 'lifetime'; remaining: number }
  // creditsPay: credits cover a contact past the allowance, so the allowance
  // is no longer a limit.
  | { kind: 'monthly'; remaining: number; limit: number; periodStart: Date; periodEnd: Date; creditsPay: boolean }

// perDay: the plan's default for a day. cap: what the day may not go past —
// the rest of the allowance, spread over the period when it has one.
// null = the plan sets no pace.
export type PlanPace = { perDay: number; cap: number | null } | null

const DAY_MS = 86_400_000

function utcDayStart(t: Date): number {
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())
}

// UTC Monday–Friday days in [from, to), at least 1.
export function weekdaysBetween(from: Date, to: Date): number {
  let n = 0
  for (let day = utcDayStart(from); day < to.getTime(); day += DAY_MS) {
    const dow = new Date(day).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
  }
  return Math.max(1, n)
}

export function planPace(input: PaceInput, now: Date): PlanPace {
  switch (input.kind) {
    case 'unlimited':
      return null
    case 'lifetime':
      return { perDay: Math.min(FREE_DAILY_PACE, input.remaining), cap: input.remaining }
    case 'monthly': {
      const left = Math.ceil(input.remaining / weekdaysBetween(now, input.periodEnd))
      if (!input.creditsPay) return { perDay: left, cap: left }
      // Past the allowance the plan's average rate keeps going on credits.
      const average = Math.ceil(input.limit / weekdaysBetween(input.periodStart, input.periodEnd))
      return { perDay: Math.max(left, average), cap: null }
    }
  }
}

export type DailyTargetSource = 'settings' | 'plan' | 'fixed'

export function resolveDailyTarget(setting: number | null, pace: PlanPace): { count: number; source: DailyTargetSource } {
  if (setting !== null) return { count: setting, source: 'settings' }
  if (pace) return { count: pace.perDay, source: 'plan' }
  return { count: FALLBACK_DAILY_TARGET, source: 'fixed' }
}

export type DailyLimit = 'target' | 'mailbox' | 'plan'

// Ties name the target.
// mailboxLeft null: drafts wait for review, so today's mailboxes do not bound them.
export function runnableNewProspects(target: number, mailboxLeft: number | null, pace: PlanPace): { count: number; limitedBy: DailyLimit } {
  const planCap = pace?.cap ?? Infinity
  const count = Math.max(0, Math.min(target, mailboxLeft ?? Infinity, planCap))
  if (count === target) return { count, limitedBy: 'target' }
  if (mailboxLeft !== null && count === Math.max(0, mailboxLeft)) return { count, limitedBy: 'mailbox' }
  return { count, limitedBy: 'plan' }
}

const LIMIT_PHRASE: Record<Exclude<DailyLimit, 'target'>, string> = {
  mailbox: 'mailbox capacity left after the follow-ups',
  plan: "the plan's allowance left for the period",
}

// null when the day reached its target.
export function shortfallReason(r: { target: number; runnable: { count: number; limitedBy: DailyLimit }; reached: number; stop: CycleStop }): string | null {
  if (r.reached >= r.target) return null
  switch (r.stop.kind) {
    case 'reached':
      return r.runnable.limitedBy === 'target' ? null : LIMIT_PHRASE[r.runnable.limitedBy]
    case 'list_spent':
      return r.stop.failed > 0 ? `${r.stop.failed} failed` : 'supply — the rest were skipped'
    case 'dry':
      return 'supply — discovery found nothing new to reach'
    case 'no_discovery':
      return r.stop.why === 'no_strategies' ? 'supply — no discovery strategies' : `supply — ${r.stop.why.paused}`
    case 'pass_cap':
      return `supply — ${MAX_DISCOVERY_PASSES} discovery passes found too few`
  }
}
