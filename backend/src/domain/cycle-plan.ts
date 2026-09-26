// Why a prospect is reachable: a first touch, a day-scale follow-up, or a
// months-scale re-approach.
export type ReachArm = 'first' | 'followup' | 'recycle'

export type ReachableSnapshot = {
  // First touches the hosted agent can make by itself (email only in send mode).
  deliverable: number
  // First touches left to a browser — the plugin's hands.
  needsHands: number
  // Emails the project's mailboxes can still send today.
  mailboxRemaining: number
  // The project sends as it writes; otherwise drafts wait for review.
  sends: boolean
  // Why outbound cannot run today at all (quota exhausted, no channel
  // enabled); null when the list itself is the only limit. A blocked day
  // neither sends nor replenishes — the list is not the problem.
  blocked: string | null
}

// A runaway-day guard, not a business rule: a strategy yielding a prospect or
// two per pass would otherwise search all day.
export const MAX_DISCOVERY_PASSES = 6

export type DiscoveryUnavailable = 'no_strategies' | { paused: string }

export type CycleStop =
  | { kind: 'reached' }
  // The list still held prospects, but the last round wrote to none of them.
  | { kind: 'list_spent'; failed: number }
  // A discovery pass left nothing new to reach.
  | { kind: 'dry' }
  | { kind: 'no_discovery'; why: DiscoveryUnavailable }
  | { kind: 'pass_cap' }

export type LastRound = { kind: 'draft'; produced: number; failed: number } | { kind: 'discover'; deliverableBefore: number } | null

export type CycleStep = { kind: 'draft'; count: number } | { kind: 'discover'; count: number } | { kind: 'stop'; stop: CycleStop }

// The day's first touches, one round at a time: write to what the list holds,
// search when it runs out or yields nothing, and stop only when there is
// nothing more to reach. Cost never stops the day (#531).
export function nextCycleStep(s: {
  want: number
  deliverable: number
  last: LastRound
  discovery: DiscoveryUnavailable | null
  passes: number
}): CycleStep {
  if (s.want <= 0) return { kind: 'stop', stop: { kind: 'reached' } }
  if (s.last?.kind === 'discover' && s.deliverable <= s.last.deliverableBefore) return { kind: 'stop', stop: { kind: 'dry' } }
  const spent = s.last?.kind === 'draft' && s.last.produced === 0 ? s.last : null
  if (s.deliverable > 0 && !spent) return { kind: 'draft', count: Math.min(s.want, s.deliverable) }
  if (s.discovery !== null) {
    return { kind: 'stop', stop: spent ? { kind: 'list_spent', failed: spent.failed } : { kind: 'no_discovery', why: s.discovery } }
  }
  if (s.passes >= MAX_DISCOVERY_PASSES) return { kind: 'stop', stop: { kind: 'pass_cap' } }
  return { kind: 'discover', count: s.want }
}
