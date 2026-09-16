import { PBEST_SAMPLES, sampleBeta } from './arm-bandit'

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

// Monte Carlo over the posterior rather than a closed-form incomplete beta:
// same seeded technique and precision class as computePBest — a second
// numeric method would buy no decision-relevant accuracy.
export function assessVitals(
  stat: { sends: number; engaged: number },
  params: FutilityParams,
  rng: () => number,
  samples: number = PBEST_SAMPLES,
): VitalsAssessment {
  const sends = Math.max(stat.sends, 0)
  const engaged = Math.min(Math.max(stat.engaged, 0), sends)
  const alpha = 1 + engaged
  const beta = 1 + sends - engaged
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
  return { sends, engaged, pDead, verdict }
}
