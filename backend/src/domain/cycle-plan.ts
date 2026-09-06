// The daily cycle's one ordering decision: replenish the list before sending
// when it cannot carry the day's outbound (daily-cycle/SKILL.md step 6).
export type ReachableSnapshot = {
  total: number
  email: number
  formOnly: number
  platformOnly: number
  // Why outbound cannot run today at all (quota exhausted, no channel
  // enabled); null when the list itself is the only limit. A blocked day
  // neither sends nor replenishes — the list is not the problem.
  blocked: string | null
}

// No email-reachable prospects with fewer than five form / platform ones, or a
// list under a third of the day's count, means the list is replenished first.
export function shouldBuildFirst(r: ReachableSnapshot, outboundCount: number): boolean {
  if (r.blocked) return false
  if (r.total === 0) return true
  if (r.email === 0 && r.formOnly + r.platformOnly < 5) return true
  return r.total < outboundCount / 3
}
