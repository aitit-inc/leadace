import { PBEST_SAMPLES, sampleBeta } from './bandit'

export type VitalsVerdict = 'ok' | 'insufficient' | 'futile'

export type VitalsAssessment = {
  sends: number
  // Sends that drew a reply or a rewarded inquiry session.
  engaged: number
  // P(engagement rate < futilitySurvivalRate) under Beta(1 + engaged, 1 + sends − engaged).
  pDead: number
  verdict: VitalsVerdict
}

export type FutilityParams = {
  futilitySurvivalRate: number
  futilityConfidence: number
  futilityMinSends: number
}

// P(rate < floor) under Beta(1 + hits, 1 + trials − hits). Monte Carlo over the
// posterior rather than a closed-form incomplete beta: same seeded technique
// and precision class as computePBest — a second numeric method would buy no
// decision-relevant accuracy.
function pBelow(trials: number, hits: number, floor: number, rng: () => number, samples: number): number {
  const n = Math.max(trials, 0)
  const k = Math.min(Math.max(hits, 0), n)
  let below = 0
  for (let i = 0; i < samples; i++) {
    if (sampleBeta(1 + k, 1 + n - k, rng) < floor) below++
  }
  return below / samples
}

export function assessVitals(
  stat: { sends: number; engaged: number },
  params: FutilityParams,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): VitalsAssessment {
  const sends = Math.max(stat.sends, 0)
  const engaged = Math.min(Math.max(stat.engaged, 0), sends)
  const pDead = pBelow(sends, engaged, params.futilitySurvivalRate, rng, samples)
  const verdict: VitalsVerdict =
    sends < params.futilityMinSends
      ? 'insufficient'
      : pDead >= params.futilityConfidence
        ? 'futile'
        : 'ok'
  return { sends, engaged, pDead, verdict }
}

// The outer layer's signal (values: #793, 2026-09-28): the frame has had its
// trials and its positive rate is below the floor. While vitals are futile the
// question is whether mail reaches people at all, not the frame.
export const FRAME_SIGNAL = { minTrials: 100, floorRate: 0.01, confidence: 0.95 } as const

export type FrameSignal = {
  trials: number
  positive: number
  // P(positive rate < FRAME_SIGNAL.floorRate).
  pBelow: number
  open: boolean
}

export function frameSignal(
  stat: { trials: number; positive: number },
  vitals: VitalsVerdict,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): FrameSignal {
  const p = pBelow(stat.trials, stat.positive, FRAME_SIGNAL.floorRate, rng, samples)
  const open = stat.trials >= FRAME_SIGNAL.minTrials && p >= FRAME_SIGNAL.confidence && vitals !== 'futile'
  return { trials: stat.trials, positive: stat.positive, pBelow: p, open }
}
