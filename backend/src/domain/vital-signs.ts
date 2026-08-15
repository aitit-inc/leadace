import { PBEST_SAMPLES, sampleBeta } from './arm-bandit'

export type VitalsVerdict = 'ok' | 'insufficient' | 'futile'

export type VitalsAssessment = {
  sends: number
  replies: number
  // P(reply rate < futilitySurvivalRate) under Beta(1 + replies, 1 + sends − replies).
  pDead: number
  verdict: VitalsVerdict
}

export type FutilityParams = {
  futilitySurvivalRate: number
  futilityConfidence: number
  futilityMinSends: number
}

// Monte Carlo over the posterior rather than a closed-form incomplete beta:
// same seeded technique and precision class as computePBest — a second
// numeric method would buy no decision-relevant accuracy.
export function assessVitals(
  stat: { sends: number; replies: number },
  params: FutilityParams,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): VitalsAssessment {
  const sends = Math.max(stat.sends, 0)
  const replies = Math.min(Math.max(stat.replies, 0), sends)
  const alpha = 1 + replies
  const beta = 1 + sends - replies
  let below = 0
  for (let i = 0; i < samples; i++) {
    if (sampleBeta(alpha, beta, rng) < params.futilitySurvivalRate) below++
  }
  const pDead = below / samples
  const verdict: VitalsVerdict =
    sends < params.futilityMinSends
      ? 'insufficient'
      : pDead >= params.futilityConfidence
        ? 'futile'
        : 'ok'
  return { sends, replies, pDead, verdict }
}
