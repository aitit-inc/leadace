// Environment values are production measurements, not free parameters:
// ~1% reply rate (2/208 new arm; 0/646 dead arm), 6.2% bounce (60-day
// threaded), ×0.57 foldering compression (GMass seed test: 43% spam),
// 84/98 arm skew (yc-hn share of attributed sends pre-D1), ~10 sends/day
// dogfooding volume.

import type { Scenario } from './environment'

const DAYS = 180
const SENDS_PER_DAY = 10
const BATCH_SIZE = 30 // keep in sync with DEFAULT_BATCH_PLAN_SIZE (levers.ts)
const BOUNCE = 0.062

const base = {
  bounceRate: BOUNCE,
  deliveryFactor: 1,
  sendsPerDay: SENDS_PER_DAY,
  batchSize: BATCH_SIZE,
  horizonDays: DAYS,
}

const clearWinner: Scenario = {
  ...base,
  name: 'clear-winner',
  strategies: [
    { slug: 'winner', replyRate: 0.02, inventory: 2000 },
    { slug: 'mid', replyRate: 0.01, inventory: 2000 },
    { slug: 'weak', replyRate: 0.005, inventory: 2000 },
    { slug: 'poor', replyRate: 0.003, inventory: 2000 },
  ],
}

const skewedIncumbent: Scenario = {
  ...base,
  name: 'skewed-incumbent',
  strategies: [
    {
      slug: 'incumbent',
      replyRate: 0.005,
      inventory: 2000,
      seedPool: 120,
      seedHistory: { total: 84, replies: 0 },
    },
    { slug: 'winner', replyRate: 0.02, inventory: 2000, seedHistory: { total: 5, replies: 0 } },
    { slug: 'mid', replyRate: 0.01, inventory: 2000, seedHistory: { total: 3, replies: 0 } },
    { slug: 'weak', replyRate: 0.005, inventory: 2000, seedHistory: { total: 2, replies: 0 } },
  ],
}

const foldered: Scenario = {
  ...clearWinner,
  name: 'foldered',
  deliveryFactor: 0.57,
}

const depletingWinner: Scenario = {
  ...base,
  name: 'depleting-winner',
  strategies: [
    { slug: 'winner', replyRate: 0.02, inventory: 100 },
    { slug: 'mid', replyRate: 0.01, inventory: 2000 },
    { slug: 'weak', replyRate: 0.005, inventory: 2000 },
  ],
}

// Null environment: any archive is premature by construction.
const flatField: Scenario = {
  ...base,
  name: 'flat-field',
  strategies: [
    { slug: 'alpha', replyRate: 0.01, inventory: 2000 },
    { slug: 'bravo', replyRate: 0.01, inventory: 2000 },
    { slug: 'charlie', replyRate: 0.01, inventory: 2000 },
    { slug: 'delta', replyRate: 0.01, inventory: 2000 },
  ],
}

// factor 0.1 ≈ hard silent foldering (the 0/646 dead arm); the measured 0.57
// fires the futility alert too rarely inside one incident to measure recovery.
const regimeShift: Scenario = {
  ...base,
  name: 'regime-shift',
  horizonDays: 240,
  strategies: clearWinner.strategies,
  deliveryPhases: [
    { fromDay: 60, factor: 0.1 },
    { fromDay: 120, factor: 1 },
  ],
}

export const banditScenarios: Scenario[] = [
  clearWinner,
  skewedIncumbent,
  foldered,
  depletingWinner,
  flatField,
  regimeShift,
]

// Single-strategy on purpose: the verdict reads project-wide sends only, and
// k = 1 skips the bandit Monte Carlo, keeping the larger seed counts cheap.
const futilityBase = { ...base, horizonDays: 180 }

export const futilityScenarios: Scenario[] = [
  {
    ...futilityBase,
    name: 'dead',
    strategies: [{ slug: 'only', replyRate: 0, inventory: 4000 }],
  },
  {
    ...futilityBase,
    name: 'near-dead',
    strategies: [{ slug: 'only', replyRate: 0.003, inventory: 4000 }],
  },
  {
    ...futilityBase,
    name: 'healthy-1pct',
    strategies: [{ slug: 'only', replyRate: 0.01, inventory: 4000 }],
  },
  // 1% × 0.57 sits below the survival line: firing here is correct by
  // design — deliverability is the thing to fix.
  {
    ...futilityBase,
    name: 'foldered-healthy',
    strategies: [{ slug: 'only', replyRate: 0.01, inventory: 4000 }],
    deliveryFactor: 0.57,
  },
  // 120-day incident so the all-history baseline (diluted by its healthy
  // prefix) reliably fires before the repair; 90 days observed after.
  {
    ...futilityBase,
    name: 'incident-recovery',
    horizonDays: 270,
    strategies: [{ slug: 'only', replyRate: 0.01, inventory: 4000 }],
    deliveryPhases: [
      { fromDay: 60, factor: 0.1 },
      { fromDay: 180, factor: 1 },
    ],
  },
]
