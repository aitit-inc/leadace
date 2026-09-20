// The daily cycle's one ordering decision: replenish the list before sending
// when it cannot carry the day's outbound (daily-cycle/SKILL.md step 5).
export type ReachableSnapshot = {
  // Prospects the hosted agent can act on by itself (email only in send mode).
  deliverable: number
  // Reachable prospects left to a browser — the plugin's hands.
  needsHands: number
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
