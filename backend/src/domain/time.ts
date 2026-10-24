import { z } from 'zod'

// The UTC calendar day (YYYY-MM-DD) every daily rule in the hosted agent keys
// on: prompts' "today", the journal window, the signal date window.
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

// An ISO 8601 UTC timestamp a model writes. zod 4.5+ refuses minute precision
// ("2026-10-24T12:30Z") by default, and models send it.
export const isoDateTimeSchema = z.union([z.iso.datetime(), z.iso.datetime({ precision: -1 })])
