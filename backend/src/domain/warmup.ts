export interface WarmupConfig {
  startPerDay: number
  rampWeeks: number
  steadyStatePerDay: number
}

export const DEFAULT_WARMUP: WarmupConfig = {
  startPerDay: 10,
  rampWeeks: 4,
  steadyStatePerDay: 25,
}

export interface MailboxWarmupState {
  // null = never sent. Stamped on first send, not at connect, so an idle
  // mailbox doesn't ramp to full cap while dormant.
  warmupStartedAt: Date | null
  dailyCapOverride: number | null
  pausedUntil: Date | null
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// null start (never sent) and a clock-skew future both read as week 0.
export function warmupWeeksElapsed(
  state: MailboxWarmupState,
  config: WarmupConfig,
  now: Date,
): number {
  if (state.warmupStartedAt === null) return 0
  const elapsed = Math.floor((now.getTime() - state.warmupStartedAt.getTime()) / WEEK_MS)
  return Math.min(config.rampWeeks, Math.max(0, elapsed))
}

function rampCap(config: WarmupConfig, weeksElapsed: number): number {
  if (weeksElapsed >= config.rampWeeks) return config.steadyStatePerDay
  const span = config.steadyStatePerDay - config.startPerDay
  return config.startPerDay + Math.floor((span * weeksElapsed) / config.rampWeeks)
}

export function mailboxDailyCap(
  state: MailboxWarmupState,
  config: WarmupConfig,
  now: Date,
): number {
  if (state.pausedUntil && now < state.pausedUntil) return 0
  if (state.dailyCapOverride !== null) return state.dailyCapOverride
  return rampCap(config, warmupWeeksElapsed(state, config, now))
}

export interface MailboxDailyStatus {
  cap: number
  used: number
  remaining: number
  // Future pause only; an elapsed pausedUntil means the day's sends are spent,
  // not paused, so it reads as null (matching mailboxDailyCap's restored cap).
  pausedUntil: Date | null
  rampWeek: number
  rampWeeks: number
  steadyStatePerDay: number
}

// The send guard (getMailboxDailyQuota), the health read (getMailboxHealth), and
// the per-identity list (listSendingIdentities) all derive from this one pure
// function — they differ only in how they wrap it (no_mailbox vs identity
// metadata), never in how they compute cap/remaining.
export function mailboxDailyStatus(
  state: MailboxWarmupState,
  used: number,
  config: WarmupConfig,
  now: Date,
): MailboxDailyStatus {
  const cap = mailboxDailyCap(state, config, now)
  return {
    cap,
    used,
    remaining: Math.max(0, cap - used),
    pausedUntil: state.pausedUntil && state.pausedUntil > now ? state.pausedUntil : null,
    rampWeek: warmupWeeksElapsed(state, config, now),
    rampWeeks: config.rampWeeks,
    steadyStatePerDay: config.steadyStatePerDay,
  }
}
