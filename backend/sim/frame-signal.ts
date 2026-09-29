// Frame experiment (#793): when should the outer layer propose rethinking the
// frame (value proposition, ICP)? Candidate KPI signal: since the frame
// started, >= minSends settled sends and P(positive rate < floor) >= confidence
// — the same posterior test as the futility vitals (frame.ts assessVitals),
// on the positive-reaction reward instead of any reply. The frame restarts
// (and the count with it) when the user approves a change.

import { seededRng } from '../src/domain/loop/bandit'
import { assessVitals } from '../src/domain/loop/frame'
import { stats } from './metrics'

export type FrameScenario = {
  name: string
  sendsPerDay: number
  // Positive rate by phase; a new phase is a new frame (the user approved a change).
  phases: { fromDay: number; rate: number }[]
  horizonDays: number
  settleDays: number
}

export type FrameSignalParams = { floor: number; confidence: number; minSends: number }

export type FrameRun = {
  // Days since its frame started at which the signal first fired, per phase; null = never.
  firedAfter: (number | null)[]
}

export function runFrame(scenario: FrameScenario, params: FrameSignalParams, seed: number, samples: number): FrameRun {
  const rng = seededRng(`frame:${scenario.name}:${seed}`)
  const firedAfter: (number | null)[] = scenario.phases.map(() => null)
  const positivesByDay: number[] = []
  let phase = 0
  for (let day = 0; day < scenario.horizonDays; day++) {
    while (phase + 1 < scenario.phases.length && day >= scenario.phases[phase + 1]!.fromDay) phase += 1
    const { fromDay, rate } = scenario.phases[phase]!
    let positives = 0
    for (let i = 0; i < scenario.sendsPerDay; i++) if (rng() < rate) positives += 1
    positivesByDay.push(positives)

    if (firedAfter[phase] !== null) continue
    let sends = 0
    let engaged = 0
    for (let d = fromDay; d <= day - scenario.settleDays; d++) {
      sends += scenario.sendsPerDay
      engaged += positivesByDay[d]!
    }
    if (sends < params.minSends) continue
    // Not date-keyed, like the vitals: a day-varying seed flips the verdict at the boundary.
    const verdict = assessVitals(
      { sends, engaged },
      { futilitySurvivalRate: params.floor, futilityConfidence: params.confidence, futilityMinSends: params.minSends },
      seededRng(`frame-signal:${scenario.name}:${seed}:${phase}`),
      samples,
    ).verdict
    if (verdict === 'futile') firedAfter[phase] = day - fromDay
  }
  return { firedAfter }
}

export function aggregateFrame(runs: FrameRun[], scenario: FrameScenario): Record<string, number | null> {
  const out: Record<string, number | null> = { runs: runs.length }
  scenario.phases.forEach((p, i) => {
    const firedAfter = runs.map((r) => r.firedAfter[i]!)
    const fired = stats(firedAfter)
    const tag = scenario.phases.length > 1 ? `@${p.fromDay}` : ''
    out[`firedFrac${tag}`] = firedAfter.filter((d) => d !== null).length / runs.length
    out[`firedDayP50${tag}`] = fired.p50
    out[`firedDayP90${tag}`] = fired.p90
  })
  return out
}
