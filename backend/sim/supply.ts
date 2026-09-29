// Supply experiment (#793): when is a discovery strategy exhausted?
// Candidate rule: once a strategy has run >= K passes, it is exhausted when its
// last K passes found at most s reachable new prospects in total. Reachable
// new per pass is Poisson around the profile's mean; counted in passes, since
// a day runs 1–6 of them depending on how many new prospects it still needs.
//
// Measured 2026-09-28 (after #822): 0–2 reachable per strategy per pass, mostly
// 0, at about $0.16 per strategy per pass — a steady mean m costs $0.16 / m
// per reachable prospect.

import { seededRng } from '../src/domain/loop/bandit'
import { stats } from './metrics'

export type SupplyProfile = {
  name: string
  // Mean reachable new prospects on the p-th pass (0-based).
  meanAt: (pass: number) => number
  // First pass from which the strategy is spent (mean 0 for good); null if never.
  spentFrom: number | null
}

export type ExhaustRule = { passes: number; atMost: number }

export type SupplyRun = {
  // Pass index at which the rule fires; null if it never did within the horizon.
  firedAt: number | null
  reachable: number
}

function poisson(mean: number, rng: () => number): number {
  if (mean <= 0) return 0
  const limit = Math.exp(-mean)
  let k = 0
  let p = rng()
  while (p > limit) {
    k += 1
    p *= rng()
  }
  return k
}

export function runSupply(profile: SupplyProfile, rule: ExhaustRule, seed: number, horizonPasses: number): SupplyRun {
  const rng = seededRng(`supply:${profile.name}:${seed}`)
  const yields: number[] = []
  let reachable = 0
  for (let pass = 0; pass < horizonPasses; pass++) {
    const got = poisson(profile.meanAt(pass), rng)
    yields.push(got)
    reachable += got
    if (yields.length >= rule.passes) {
      const recent = yields.slice(-rule.passes).reduce((a, b) => a + b, 0)
      if (recent <= rule.atMost) return { firedAt: pass, reachable }
    }
  }
  return { firedAt: null, reachable }
}

export function aggregateSupply(runs: SupplyRun[], profile: SupplyProfile, horizonPasses: number): Record<string, number | null> {
  const fired = stats(runs.map((r) => r.firedAt))
  // Passes run while spent, before the rule dropped the strategy (the whole
  // rest of the horizon if it never did).
  const spentFrom = profile.spentFrom
  const wasted =
    spentFrom === null
      ? null
      : runs.reduce((acc, r) => acc + Math.max(0, (r.firedAt ?? horizonPasses - 1) + 1 - spentFrom), 0) / runs.length
  // Dropped while it still had supply.
  const early = runs.filter((r) => r.firedAt !== null && (spentFrom === null || r.firedAt < spentFrom)).length
  return {
    runs: runs.length,
    firedFrac: runs.filter((r) => r.firedAt !== null).length / runs.length,
    firedPassP50: fired.p50,
    firedPassP90: fired.p90,
    wastedPassesMean: wasted,
    droppedEarlyFrac: early / runs.length,
    reachableMean: runs.reduce((a, r) => a + r.reachable, 0) / runs.length,
  }
}
