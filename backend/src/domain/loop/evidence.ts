import type { Channel, EmployeeBand, RejectionPrimaryReason } from '../../db/schema'
import { sendOutcome, sendReaction, type Reaction, type RewardWeights } from './reaction'

// Share of human replies that have arrived `ageDays` after the send, linear in
// log(age) through knots measured in production on 2026-10-17: half within six
// hours, 90% within six days, all by fourteen. The simulation found the loop's
// decisions unchanged when the true delay was twice this (#906).
export const REPLY_ARRIVAL: readonly (readonly [days: number, share: number])[] = [
  [1 / 96, 0],
  [0.25, 0.5],
  [6, 0.9],
  [14, 1],
]

// The age by which every reply has arrived.
export const REPLY_ARRIVAL_DAYS = REPLY_ARRIVAL[REPLY_ARRIVAL.length - 1]![0]

export function replyArrivalShare(ageDays: number): number {
  if (ageDays <= REPLY_ARRIVAL[0]![0]) return 0
  for (let i = 1; i < REPLY_ARRIVAL.length; i++) {
    const [t1, f1] = REPLY_ARRIVAL[i]!
    if (ageDays < t1) {
      const [t0, f0] = REPLY_ARRIVAL[i - 1]!
      return f0 + ((f1 - f0) * Math.log(ageDays / t0)) / Math.log(t1 / t0)
    }
  }
  return 1
}

// One sent message, with every attribute the loop measures by and every
// reaction it drew so far, in the order they arrived.
export type SendObservation = {
  outreachLogId: number
  sentAt: Date
  variantId: string | null
  strategy: string | null
  channel: Channel
  industry: string | null
  employeeBand: EmployeeBand
  country: string | null
  priority: number | null
  // An email carrying our Message-ID, the only kind a bounce can bind to.
  bounceable: boolean
  reactions: Reaction[]
}

// `trials` is what the bandit and every rate divide by: a send that drew a
// human reaction counts once the moment it arrives, a silent one by the share
// of replies that would have arrived by its age, a bounced one not at all — it
// never reached anyone. `rewardSum` never exceeds `trials`.
export type Evidence = {
  sends: number
  trials: number
  rewardSum: number
  // Sends a person answered in any way, a no included.
  replied: number
  positive: number
  // Positive sends included.
  interested: number
  declined: number
  reasons: Partial<Record<RejectionPrimaryReason, number>>
  bounced: number
  bounceable: number
}

const emptyEvidence = (): Evidence => ({ sends: 0, trials: 0, rewardSum: 0, replied: 0, positive: 0, interested: 0, declined: 0, reasons: {}, bounced: 0, bounceable: 0 })

const DAY_MS = 24 * 60 * 60 * 1000

function add(into: Evidence, send: SendObservation, now: Date, weights: RewardWeights): void {
  const outcome = sendOutcome(send.reactions)
  into.sends++
  if (send.bounceable) into.bounceable++
  if (outcome.kind === 'bounced') {
    into.bounced++
    return
  }
  if (outcome.kind === 'silent') {
    into.trials += replyArrivalShare((now.getTime() - send.sentAt.getTime()) / DAY_MS)
    return
  }
  into.trials++
  into.replied++
  into.rewardSum += sendReaction(send.reactions, weights).reward
  if (outcome.kind === 'positive') into.positive++
  if (outcome.kind === 'declined') {
    into.declined++
    if (outcome.reason !== null) into.reasons[outcome.reason] = (into.reasons[outcome.reason] ?? 0) + 1
  } else into.interested++
}

export function evidenceOf(sends: readonly SendObservation[], now: Date, weights: RewardWeights): Evidence {
  const out = emptyEvidence()
  for (const send of sends) add(out, send, now, weights)
  return out
}

// A send whose key is undefined is left out.
export function evidenceBy<K>(
  sends: readonly SendObservation[],
  key: (send: SendObservation) => K | undefined,
  now: Date,
  weights: RewardWeights,
): Map<K, Evidence> {
  const out = new Map<K, Evidence>()
  for (const send of sends) {
    const k = key(send)
    if (k === undefined) continue
    const held = out.get(k) ?? emptyEvidence()
    add(held, send, now, weights)
    out.set(k, held)
  }
  return out
}
