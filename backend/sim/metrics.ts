import type { LeverConfig } from '../src/domain/lever-config'
import type { RunResult, Scenario } from './environment'

export type RunMetrics = {
  discoveryDay: number | null
  sendsUntilDiscovery: number | null
  prematureArchive: boolean
  archiveCount: number
  rescueDay: number | null
  captureRatio: number
  regretAtEnd: number
  firstFutileDay: number | null
  sendsAtFirstFutile: number | null
  everFutile: boolean
  vitalsFlickers: number
  shortfallTotal: number
}

const argmax = (weights: Record<string, number>): string | null => {
  let best: string | null = null
  let bestW = -Infinity
  for (const [slug, w] of Object.entries(weights)) {
    if (w > bestW) {
      best = slug
      bestW = w
    }
  }
  return best
}

export function trueBestSlug(scenario: Scenario): string {
  return [...scenario.strategies].sort((a, b) => b.replyRate - a.replyRate)[0]!.slug
}

export function extractRunMetrics(
  run: RunResult,
  scenario: Scenario,
  oracle: number[],
  config: LeverConfig,
): RunMetrics {
  const best = trueBestSlug(scenario)
  const lastDay = run.days.length - 1

  // Discovery counts only the final streak that reaches the horizon: a pick
  // that later flips back was not held.
  let discoveryDay: number | null = null
  for (let d = lastDay; d >= 0; d--) {
    if (argmax(run.days[d]!.weights) === best) discoveryDay = d
    else break
  }
  // A short tail is indistinguishable from luck; require at least a week held.
  if (discoveryDay !== null && lastDay - discoveryDay < 6) discoveryDay = null
  const sendsUntilDiscovery =
    discoveryDay === null ? null : run.cumulativeSends[discoveryDay]!

  let rescueDay: number | null = null
  for (const day of run.days) {
    if ((day.matureTotals[best] ?? 0) >= config.minSamplePerArm) {
      rescueDay = day.day
      break
    }
  }

  const finalExpected = run.cumulativeExpected[lastDay]!
  const finalOracle = oracle[lastDay]!

  let firstFutileDay: number | null = null
  let vitalsFlickers = 0
  let prevFutile = false
  let shortfallTotal = 0
  for (const day of run.days) {
    const futile = day.vitalsVerdict === 'futile'
    if (futile && firstFutileDay === null) firstFutileDay = day.day
    if (prevFutile && !futile) vitalsFlickers += 1
    prevFutile = futile
    shortfallTotal += day.registrationShortfall
  }

  return {
    discoveryDay,
    sendsUntilDiscovery,
    prematureArchive: best in run.archivedAt,
    archiveCount: Object.keys(run.archivedAt).length,
    rescueDay,
    captureRatio: finalOracle > 0 ? finalExpected / finalOracle : 1,
    regretAtEnd: finalOracle - finalExpected,
    firstFutileDay,
    sendsAtFirstFutile: firstFutileDay === null ? null : run.cumulativeSends[firstFutileDay]!,
    everFutile: firstFutileDay !== null,
    vitalsFlickers,
    shortfallTotal,
  }
}

const quantile = (sorted: number[], q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!

// Nulls (event never happened) are excluded from quantiles; the companion
// *Frac/*Rate column carries how often the event happened at all.
const stats = (values: (number | null)[]): { p50: number | null; p90: number | null; mean: number | null } => {
  const xs = values.filter((v): v is number => v !== null).sort((a, b) => a - b)
  if (xs.length === 0) return { p50: null, p90: null, mean: null }
  return {
    p50: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  }
}

export type AggregateRow = Record<string, number | null>

export function aggregate(runs: RunMetrics[]): AggregateRow {
  const n = runs.length
  const frac = (pred: (r: RunMetrics) => boolean): number =>
    runs.filter(pred).length / n
  const discovery = stats(runs.map((r) => r.discoveryDay))
  const discoverySends = stats(runs.map((r) => r.sendsUntilDiscovery))
  const rescue = stats(runs.map((r) => r.rescueDay))
  const capture = stats(runs.map((r) => r.captureRatio))
  const regret = stats(runs.map((r) => r.regretAtEnd))
  const futileDay = stats(runs.map((r) => r.firstFutileDay))
  const futileSends = stats(runs.map((r) => r.sendsAtFirstFutile))
  return {
    runs: n,
    discoveredFrac: frac((r) => r.discoveryDay !== null),
    discoveryDayP50: discovery.p50,
    discoveryDayP90: discovery.p90,
    discoverySendsP50: discoverySends.p50,
    discoverySendsP90: discoverySends.p90,
    prematureArchiveRate: frac((r) => r.prematureArchive),
    // In a flat (no-true-best) field prematureArchiveRate only tracks one
    // arbitrary slug — anyArchiveRate is the honest churn measure there.
    anyArchiveRate: frac((r) => r.archiveCount > 0),
    archiveCountMean: stats(runs.map((r) => r.archiveCount)).mean,
    rescueDayP50: rescue.p50,
    rescueDayP90: rescue.p90,
    captureRatioMean: capture.mean,
    captureRatioP50: capture.p50,
    regretMean: regret.mean,
    futileRate: frac((r) => r.everFutile),
    futileDayP50: futileDay.p50,
    futileDayP90: futileDay.p90,
    futileSendsP50: futileSends.p50,
    futileSendsP90: futileSends.p90,
    vitalsFlickersMean: stats(runs.map((r) => r.vitalsFlickers)).mean,
    shortfallMean: stats(runs.map((r) => r.shortfallTotal)).mean,
  }
}
