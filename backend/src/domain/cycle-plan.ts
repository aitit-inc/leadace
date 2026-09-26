// Why a prospect is reachable: a first touch, a day-scale follow-up, or a
// months-scale re-approach.
export type ReachArm = 'first' | 'followup' | 'recycle'

// The daily cycle's one ordering decision: replenish the list before sending
// when it cannot carry the day's outbound (daily-cycle/SKILL.md step 5).
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

// A list under a third of the day's count is replenished first; what only a
// browser can reach does not count toward it.
export function shouldBuildFirst(r: ReachableSnapshot, outboundCount: number): boolean {
  return r.blocked === null && r.deliverable < outboundCount / 3
}
