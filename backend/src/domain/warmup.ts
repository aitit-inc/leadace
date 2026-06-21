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
  warmupEnabled: boolean
  // Ceiling during ramp; replaces the steady-state cap when warmup is disabled.
  dailyCapOverride: number | null
  pausedUntil: Date | null
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

// Completed weeks since warmup began, clamped to [0, rampWeeks]. null start
// (never sent) and a clock-skew future both read as week 0; past the ramp it
// saturates at rampWeeks. Drives both the cap step and the health read-out.
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
  if (!state.warmupEnabled) return state.dailyCapOverride ?? config.steadyStatePerDay
  const ceiling = state.dailyCapOverride ?? config.steadyStatePerDay
  return Math.min(rampCap(config, warmupWeeksElapsed(state, config, now)), ceiling)
}
