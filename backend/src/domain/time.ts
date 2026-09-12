// The UTC calendar day (YYYY-MM-DD) every daily rule in the hosted agent keys
// on: prompts' "today", the journal window, the signal date window.
export function utcDateKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
