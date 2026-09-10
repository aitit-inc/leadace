// A schedule is one saved instruction the hosted agent runs unattended on a
// recurring local hour. The instruction is the whole payload — what a run may
// do is a fixed policy (services/chat/unattended.ts), never a field — so the
// recurrence rule is all the structure there is.
import { z } from 'zod'

export const SCHEDULE_PROMPT_MAX_CHARS = 2000
// An abuse ceiling on unattended model turns, not a plan feature: plans
// differentiate on throughput only.
export const MAX_SCHEDULES_PER_PROJECT = 5
// A broken instruction must not burn the budget nightly.
export const MAX_CONSECUTIVE_FAILURES = 3

// 0 = Sunday … 6 = Saturday, as Date#getDay reports it.
export const DAYS_OF_WEEK = [0, 1, 2, 3, 4, 5, 6] as const
export type DayOfWeek = (typeof DAYS_OF_WEEK)[number]

export const daysSchema = z.array(z.literal(DAYS_OF_WEEK)).min(1).max(7)
export const hourSchema = z.number().int().min(0).max(23)
export const promptSchema = z.string().trim().min(1).max(SCHEDULE_PROMPT_MAX_CHARS)
// A zone the runtime cannot resolve would throw on every later run of that
// schedule, so it is refused at write time.
export const timezoneSchema = z.string().min(1).max(64).refine(isKnownTimezone, 'Unknown time zone')

export function isKnownTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

// A bitmask, so "every day" is one value and the set cannot carry duplicates
// or an order; the array is the wire and UI shape.
export function daysToMask(days: readonly DayOfWeek[]): number {
  return days.reduce<number>((mask, day) => mask | (1 << day), 0)
}

export function maskToDays(mask: number): DayOfWeek[] {
  return DAYS_OF_WEEK.filter((day) => (mask & (1 << day)) !== 0)
}

export type Recurrence = {
  timezone: string
  hour: number
  daysOfWeek: number
}

// Resolved per run rather than stored as a UTC hour, so a zone that observes
// DST keeps its local hour.
export function localTime(now: Date, timezone: string): { dateKey: string; hour: number; day: DayOfWeek } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  const dateKey = `${get('year')}-${get('month')}-${get('day')}`
  return { dateKey, hour: Number(get('hour')), day: new Date(`${dateKey}T00:00:00Z`).getUTCDay() as DayOfWeek }
}

export function isDue(recurrence: Recurrence, now: Date): boolean {
  const local = localTime(now, recurrence.timezone)
  return local.hour === recurrence.hour && (recurrence.daysOfWeek & (1 << local.day)) !== 0
}

// One key per local hour: whoever takes it owns that hour, however often the
// cron fires. A DST fall-back repeats the hour and the key with it — one run.
export function runKey(timezone: string, now: Date): string {
  const local = localTime(now, timezone)
  return `${local.dateKey}T${String(local.hour).padStart(2, '0')}`
}
