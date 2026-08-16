import type { LeverConfig } from '../src/domain/lever-config'
import { incidentWindowOf, type RunResult, type Scenario } from './environment'

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
  // Regime-scenario only; null elsewhere.
  firedDuringIncident: boolean | null
  recoveredAfterRepair: boolean | null
  clearDaysAfterRepair: number | null
  captureAfterRepair: number | null
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

  const incident = incidentWindowOf(scenario)
  let firedDuringIncident: boolean | null = null
  let recoveredAfterRepair: boolean | null = null
  let clearDaysAfterRepair: number | null = null
  let captureAfterRepair: number | null = null
  if (incident !== null && incident.repair > 0 && incident.repair <= lastDay) {
    const { start, repair } = incident
    // A futile day inside [incidentStart, repair): a pre-incident false fire
    // that clears before the incident must not count.
    firedDuringIncident = run.days.some(
      (d) => d.day >= start && d.day < repair && d.vitalsVerdict === 'futile',
    )
    if (firedDuringIncident) {
      let lastFutile: number | null = null
      for (const day of run.days) {
        if (day.day >= repair && day.vitalsVerdict === 'futile') lastFutile = day.day
      }
      if (lastFutile === null) {
        recoveredAfterRepair = true
        clearDaysAfterRepair = 0
      } else if (lastFutile === lastDay) {
        recoveredAfterRepair = false
      } else {
        recoveredAfterRepair = true
        clearDaysAfterRepair = lastFutile + 1 - repair
      }
    }
    const oracleGain = oracle[lastDay]! - oracle[repair - 1]!
    captureAfterRepair =
      oracleGain > 0
        ? (finalExpected - run.cumulativeExpected[repair - 1]!) / oracleGain
        : 1
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
    firedDuringIncident,
    recoveredAfterRepair,
    clearDaysAfterRepair,
    captureAfterRepair,
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
  const regime = runs.filter((r) => r.firedDuringIncident !== null)
  const fired = regime.filter((r) => r.firedDuringIncident === true)
  const clearDays = stats(fired.map((r) => r.clearDaysAfterRepair))
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
    firedIncidentFrac: regime.length > 0 ? fired.length / regime.length : null,
    recoveredOfFiredFrac:
      fired.length > 0
        ? fired.filter((r) => r.recoveredAfterRepair === true).length / fired.length
        : null,
    clearDaysP50: clearDays.p50,
    clearDaysP90: clearDays.p90,
    captureAfterRepairMean: stats(runs.map((r) => r.captureAfterRepair)).mean,
  }
}
