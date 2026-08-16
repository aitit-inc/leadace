// Usage (from backend/):
//   npx tsx sim/run.ts [--experiment=bandit|futility] [--quick] [--seeds=N] [--samples=N]

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leverConfigSchema, type LeverConfigPatch } from '../src/domain/lever-config'
import { incidentWindowOf, oracleTrajectory, runScenario, type Scenario } from './environment'
import { aggregate, extractRunMetrics, type AggregateRow } from './metrics'
import { banditScenarios, futilityScenarios } from './scenarios'

// sim: policies outside LeverConfig; resetAtRepair is a no-op without
// deliveryPhases (those rows duplicate `default`).
type ConfigVariant = {
  label: string
  patch: LeverConfigPatch
  sim?: { futilityLookbackDays?: number; resetAtRepair?: boolean }
}

const banditVariants: ConfigVariant[] = [
  { label: 'default', patch: {} },
  { label: 'floor=0.05', patch: { strategyWeightFloor: 0.05 } },
  { label: 'floor=0.2', patch: { strategyWeightFloor: 0.2 } },
  { label: 'archive=0.02', patch: { archiveThreshold: 0.02 } },
  { label: 'archive=0.1', patch: { archiveThreshold: 0.1 } },
  { label: 'minSample=15', patch: { minSamplePerArm: 15 } },
  { label: 'minSample=60', patch: { minSamplePerArm: 60 } },
  { label: 'explore=0.1', patch: { explorationShare: 0.1 } },
  { label: 'explore=0.3', patch: { explorationShare: 0.3 } },
  { label: 'lookback=180', patch: { rewardLookbackDays: 180 } },
  { label: 'lookback=90', patch: { rewardLookbackDays: 90 } },
  { label: 'epoch@repair', patch: {}, sim: { resetAtRepair: true } },
]

const futilityVariants: ConfigVariant[] = [
  { label: 'default', patch: {} },
  { label: 'survival=0.005', patch: { futilitySurvivalRate: 0.005 } },
  { label: 'survival=0.02', patch: { futilitySurvivalRate: 0.02 } },
  { label: 'confidence=0.9', patch: { futilityConfidence: 0.9 } },
  { label: 'confidence=0.95', patch: { futilityConfidence: 0.95 } },
  { label: 'minSends=50', patch: { futilityMinSends: 50 } },
  { label: 'minSends=200', patch: { futilityMinSends: 200 } },
  // Frontier probes between the 0.005 and 0.01 survival lines: OFAT showed
  // survivalRate dominates and the default sits on the measured ~1% boundary.
  { label: 'survival=0.0075', patch: { futilitySurvivalRate: 0.0075 } },
  { label: 'survival=0.0075,conf=0.99', patch: { futilitySurvivalRate: 0.0075, futilityConfidence: 0.99 } },
  { label: 'survival=0.005,conf=0.9', patch: { futilitySurvivalRate: 0.005, futilityConfidence: 0.9 } },
  { label: 'fwindow=120', patch: {}, sim: { futilityLookbackDays: 120 } },
  { label: 'fwindow=90', patch: {}, sim: { futilityLookbackDays: 90 } },
  { label: 'fwindow=60', patch: {}, sim: { futilityLookbackDays: 60 } },
  { label: 'epoch@repair', patch: {}, sim: { resetAtRepair: true } },
]

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const quick = args.includes('--quick')
const experiment = flag('experiment') ?? 'all'
const mcSamples = Number(flag('samples') ?? 500)
const banditSeeds = Number(flag('seeds') ?? (quick ? 20 : 100))
const futilitySeeds = Number(flag('seeds') ?? (quick ? 50 : 400))

const __dirname =
  typeof import.meta.dirname === 'string'
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url))
const outDir = resolve(__dirname, 'out')
mkdirSync(outDir, { recursive: true })

type ResultRow = { variant: string; scenario: string; metrics: AggregateRow }

function sweep(
  name: string,
  variants: ConfigVariant[],
  scenarios: Scenario[],
  seeds: number,
): ResultRow[] {
  const rows: ResultRow[] = []
  for (const variant of variants) {
    const config = leverConfigSchema.parse(variant.patch)
    for (const scenario of scenarios) {
      const started = Date.now()
      const oracle = oracleTrajectory(scenario)
      const params = {
        config,
        mcSamples,
        futilityLookbackDays: variant.sim?.futilityLookbackDays,
        resetStatsAtDay: variant.sim?.resetAtRepair ? incidentWindowOf(scenario)?.repair : undefined,
      }
      const metrics = []
      for (let seed = 0; seed < seeds; seed++) {
        metrics.push(
          extractRunMetrics(runScenario(scenario, seed, params), scenario, oracle, config),
        )
      }
      rows.push({ variant: variant.label, scenario: scenario.name, metrics: aggregate(metrics) })
      console.error(
        `[${name}] ${variant.label} × ${scenario.name}: ${seeds} seeds in ${((Date.now() - started) / 1000).toFixed(1)}s`,
      )
    }
  }
  return rows
}

const fmt = (v: number | null): string =>
  v === null ? '—' : Number.isInteger(v) ? String(v) : v.toFixed(3)

function printTable(rows: ResultRow[], columns: string[]): void {
  const header = ['variant', 'scenario', ...columns]
  const lines = rows.map((r) => [
    r.variant,
    r.scenario,
    ...columns.map((c) => fmt(r.metrics[c] ?? null)),
  ])
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)))
  const render = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i]!)).join('  ')
  console.log(render(header))
  for (const line of lines) console.log(render(line))
}

function writeOutputs(name: string, seeds: number, rows: ResultRow[]): void {
  const meta = { experiment: name, seeds, mcSamples, generatedAt: new Date().toISOString() }
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify({ meta, rows }, null, 2))
  const csvCell = (v: string | number | null): string => {
    const s = v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const columns = Object.keys(rows[0]!.metrics)
  const csv = [
    ['variant', 'scenario', ...columns].map(csvCell).join(','),
    ...rows.map((r) =>
      [r.variant, r.scenario, ...columns.map((c) => r.metrics[c] ?? null)].map(csvCell).join(','),
    ),
  ].join('\n')
  writeFileSync(resolve(outDir, `${name}.csv`), csv)
  console.error(`[${name}] wrote sim/out/${name}.{json,csv}`)
}

if (experiment === 'bandit' || experiment === 'all') {
  const rows = sweep('bandit', banditVariants, banditScenarios, banditSeeds)
  writeOutputs('bandit', banditSeeds, rows)
  console.log('\n== bandit ==')
  printTable(rows, [
    'discoveredFrac',
    'discoverySendsP50',
    'discoverySendsP90',
    'prematureArchiveRate',
    'anyArchiveRate',
    'rescueDayP90',
    'captureRatioMean',
    'captureAfterRepairMean',
    'shortfallMean',
  ])
}

if (experiment === 'futility' || experiment === 'all') {
  const rows = sweep('futility', futilityVariants, futilityScenarios, futilitySeeds)
  writeOutputs('futility', futilitySeeds, rows)
  console.log('\n== futility ==')
  printTable(rows, [
    'futileRate',
    'futileDayP50',
    'futileDayP90',
    'futileSendsP50',
    'futileSendsP90',
    'vitalsFlickersMean',
    'firedIncidentFrac',
    'recoveredOfFiredFrac',
    'clearDaysP50',
    'clearDaysP90',
  ])
}
