// Reply delay in the simulated market, and the two ways the loop can count it
// (#906). 'mature', the rule before #906: a send counts once it is
// LEGACY_MATURE_DAYS old. 'delayed', production since #906
// (domain/loop/evidence): a send that drew a human reply counts as one trial the
// moment the reply arrives; a send still silent at age a counts as F(a) of a
// trial, F being the reply-arrival share the loop assumes. The stat handed to
// decide() is total = Σ weights, rewardSum = Σ arrived rewards.

import { REPLY_ARRIVAL, REPLY_ARRIVAL_DAYS, replyArrivalShare } from '../src/domain/loop/evidence'

export const LEGACY_MATURE_DAYS = 14

// The market's delay is the one the loop assumes, so a scaled market
// (trueDelayScale) tests a wrong assumption.
export function sampleReplyDelay(u: number): number {
  for (let i = 1; i < REPLY_ARRIVAL.length; i++) {
    const [t1, f1] = REPLY_ARRIVAL[i]!
    if (u < f1) {
      const [t0, f0] = REPLY_ARRIVAL[i - 1]!
      return t0 * Math.exp(((u - f0) / (f1 - f0)) * Math.log(t1 / t0))
    }
  }
  return REPLY_ARRIVAL_DAYS
}

export type EvidenceModel =
  | { kind: 'mature'; windowDays: number }
  // `cdf` is the delay the loop assumes, not necessarily the market's.
  | { kind: 'delayed'; cdf: (ageDays: number) => number }

export const productionEvidence: EvidenceModel = { kind: 'delayed', cdf: replyArrivalShare }

// Sent right after the tick of `day`; replyAt is null for a send that never draws a human reply.
export type SimSend = { day: number; reward: number; replyAt: number | null }

export type SendEvidence = { weight: number; reward: number }

export function sendEvidence(send: SimSend, today: number, model: EvidenceModel): SendEvidence {
  const age = today - send.day
  const arrived = send.replyAt !== null && send.replyAt <= today
  if (model.kind === 'mature') return age < model.windowDays ? { weight: 0, reward: 0 } : { weight: 1, reward: arrived ? send.reward : 0 }
  if (age <= 0) return { weight: 0, reward: 0 }
  return arrived ? { weight: 1, reward: send.reward } : { weight: model.cdf(age), reward: 0 }
}

export type LogStat = { total: number; rewardSum: number; sinceEntry: number }

export type EvidenceLog = {
  add: (send: SimSend) => void
  // The option (re-)entered the active set at the tick of `day`.
  enter: (day: number) => void
  stat: (today: number) => LogStat
}

// A send at least settleAge days old counts as one full trial with its reward
// in both models, so it folds into fixed sums; settleAge must exceed the
// market's longest reply delay and the window.
export function evidenceLog(model: EvidenceModel, settleAge: number): EvidenceLog {
  const sends: SimSend[] = []
  let next = 0
  let enteredDay = 0
  const settled: LogStat = { total: 0, rewardSum: 0, sinceEntry: 0 }
  return {
    add: (send) => {
      sends.push(send)
    },
    enter: (day) => {
      enteredDay = day
      settled.sinceEntry = 0
    },
    stat: (today) => {
      while (next < sends.length && today - sends[next]!.day >= settleAge) {
        const s = sends[next]!
        settled.total += 1
        settled.rewardSum += s.reward
        if (s.day >= enteredDay) settled.sinceEntry += 1
        next += 1
      }
      const out = { ...settled }
      for (let i = next; i < sends.length; i++) {
        const s = sends[i]!
        const e = sendEvidence(s, today, model)
        out.total += e.weight
        out.rewardSum += e.reward
        if (s.day >= enteredDay) out.sinceEntry += e.weight
      }
      return out
    },
  }
}

export const settleAgeFor = (model: EvidenceModel, trueDelayScale: number): number =>
  Math.ceil(Math.max(REPLY_ARRIVAL_DAYS * Math.max(trueDelayScale, 1), model.kind === 'mature' ? model.windowDays : 0)) + 1
