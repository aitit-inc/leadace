// Usage (from backend/):
//   npx tsx sim/run.ts [--experiment=bandit|futility|options|supply|frame] [--quick] [--seeds=N] [--samples=N] [--only=label,…]

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { leverConfigSchema, type LeverConfigPatch } from '../src/domain/loop/config'
import { incidentWindowOf, oracleTrajectory, runScenario, type Scenario } from './environment'
import { aggregate, extractRunMetrics, type AggregateRow } from './metrics'
import { banditScenarios, frameScenarios, futilityScenarios, optionsScenarios, supplyProfiles } from './scenarios'
import { aggregateOptions, runOptions, type OptionsPolicy, type ProposedRules } from './options'
import { aggregateSupply, runSupply, type ExhaustRule } from './supply'
import { aggregateFrame, runFrame, type FrameSignalParams } from './frame-signal'

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

// #793 middle layer. `proposed` runs the candidate rules (proposed.ts); the
// config patch carries N (minSamplePerArm) and τ (archiveThreshold) for both.
type OptionsVariant = {
  label: string
  patch: LeverConfigPatch
  proposed?: ProposedRules
}

// Chosen from the 2026-09-28 sweep (#793): the leader test, τ = 0.02, N and
// minActive unchanged; each row below moves one value.
const PROPOSED = { compare: 'leader', restoreAt: 0.3, restoreRotated: false, slots: 3, minActive: 2, capImmature: true } as const
const PROPOSED_PATCH: LeverConfigPatch = { archiveThreshold: 0.02 }

const optionsVariants: OptionsVariant[] = [
  { label: 'current', patch: {} },
  { label: 'proposed', patch: PROPOSED_PATCH, proposed: PROPOSED },
  { label: 'compare=pool', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, compare: 'pool' } },
  { label: 'slots=2', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, slots: 2, minActive: 1 } },
  { label: 'slots=4', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, slots: 4 } },
  { label: 'N=60', patch: { ...PROPOSED_PATCH, minSamplePerArm: 60 }, proposed: PROPOSED },
  { label: 'tau=0.01', patch: { archiveThreshold: 0.01 }, proposed: PROPOSED },
  { label: 'tau=0.05', patch: { archiveThreshold: 0.05 }, proposed: PROPOSED },
  { label: 'restore=0.1', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, restoreAt: 0.1 } },
  { label: 'restore=0.5', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, restoreAt: 0.5 } },
  { label: 'no-restore', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, restoreAt: 2 } },
  { label: 'restore-rotated', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, restoreRotated: true } },
  { label: 'rotate-after-30d', patch: { ...PROPOSED_PATCH, stagnationTicks: 30 }, proposed: PROPOSED },
  { label: 'no-rotation', patch: { ...PROPOSED_PATCH, stagnationTicks: 100_000 }, proposed: PROPOSED },
  { label: 'no-cap', patch: PROPOSED_PATCH, proposed: { ...PROPOSED, capImmature: false } },
]

const supplyRules: ExhaustRule[] = [
  ...[4, 6, 8, 10].map((passes) => ({ passes, atMost: 0 })),
  ...[6, 8, 10, 12].map((passes) => ({ passes, atMost: 1 })),
  ...[10, 12].map((passes) => ({ passes, atMost: 2 })),
]
const SUPPLY_HORIZON_PASSES = 100

const frameParams: { label: string; params: FrameSignalParams }[] = [
  ...[0.005, 0.01, 0.015].flatMap((floor) =>
    [0.9, 0.95, 0.99].map((confidence) => ({
      label: `floor=${floor},conf=${confidence}`,
      params: { floor, confidence, minSends: 100 },
    })),
  ),
  { label: 'floor=0.01,conf=0.95,min=300', params: { floor: 0.01, confidence: 0.95, minSends: 300 } },
]

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const quick = args.includes('--quick')
const experiment = flag('experiment') ?? 'all'
const mcSamples = Number(flag('samples') ?? 500)
const banditSeeds = Number(flag('seeds') ?? (quick ? 20 : 100))
const futilitySeeds = Number(flag('seeds') ?? (quick ? 50 : 400))
// 100 seeds left wrong-archive counts moving ±0.4/year between market samples.
const optionsSeeds = Number(flag('seeds') ?? (quick ? 20 : 300))
const supplySeeds = Number(flag('seeds') ?? (quick ? 200 : 2000))
const frameSeeds = Number(flag('seeds') ?? (quick ? 50 : 200))
// Splits a slow sweep across processes; each writes its own output file.
const only = flag('only')?.split(',')
const keep = (label: string): boolean => only === undefined || only.includes(label)

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

function writeOutputs(experiment: string, seeds: number, rows: ResultRow[]): void {
  const name = only === undefined ? experiment : `${experiment}.${only.join('+')}`
  const meta = { experiment: name, seeds, mcSamples, generatedAt: new Date().toISOString() }
  writeFileSync(resolve(outDir, `${name}.json`), JSON.stringify({ meta, rows }, null, 2))
  const csvCell = (v: string | number | null): string => {
    const s = v === null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // A union: a frame-change scenario carries per-phase keys the others lack.
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r.metrics)))]
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

if (experiment === 'options' || experiment === 'all') {
  const rows: ResultRow[] = []
  for (const variant of optionsVariants.filter((v) => keep(v.label))) {
    const config = leverConfigSchema.parse(variant.patch)
    const policy: OptionsPolicy = variant.proposed ? { kind: 'proposed', config, ...variant.proposed } : { kind: 'current', config }
    for (const scenario of optionsScenarios) {
      const started = Date.now()
      const runs = Array.from({ length: optionsSeeds }, (_, seed) => runOptions(scenario, seed, policy, mcSamples))
      rows.push({ variant: variant.label, scenario: scenario.name, metrics: aggregateOptions(runs, scenario) })
      console.error(`[options] ${variant.label} × ${scenario.name}: ${optionsSeeds} seeds in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    }
  }
  writeOutputs('options', optionsSeeds, rows)
  console.log('\n== options ==')
  printTable(rows, [
    'rateLift',
    'capture',
    'wrongArchiveShare',
    'wrongPerYear',
    'wrongRotationsPerYear',
    'leaderRight',
    'archivesPerYear',
    'rotationsPerYear',
    'restoresPerYear',
    'flipsPerYear',
    'createdPerYear',
    'immatureShare',
    'bestArchivedAtEnd',
    'bestGoneByRotation',
    'endGapMean',
  ])
}

if (experiment === 'supply' || experiment === 'all') {
  const rows: ResultRow[] = []
  for (const rule of supplyRules) {
    const label = `K=${rule.passes},s<=${rule.atMost}`
    if (!keep(label)) continue
    for (const profile of supplyProfiles) {
      const runs = Array.from({ length: supplySeeds }, (_, seed) => runSupply(profile, rule, seed, SUPPLY_HORIZON_PASSES))
      rows.push({ variant: label, scenario: profile.name, metrics: aggregateSupply(runs, profile, SUPPLY_HORIZON_PASSES) })
    }
  }
  writeOutputs('supply', supplySeeds, rows)
  console.log('\n== supply ==')
  printTable(rows, ['firedFrac', 'firedPassP50', 'firedPassP90', 'wastedPassesMean', 'droppedEarlyFrac', 'reachableMean'])
}

if (experiment === 'frame' || experiment === 'all') {
  const rows: ResultRow[] = []
  for (const { label, params } of frameParams.filter((f) => keep(f.label))) {
    for (const scenario of frameScenarios) {
      const runs = Array.from({ length: frameSeeds }, (_, seed) => runFrame(scenario, params, seed, mcSamples))
      rows.push({ variant: label, scenario: scenario.name, metrics: aggregateFrame(runs, scenario) })
    }
    console.error(`[frame] ${label}: ${frameSeeds} seeds`)
  }
  writeOutputs('frame', frameSeeds, rows)
  console.log('\n== frame ==')
  printTable(rows, ['firedFrac', 'firedDayP50', 'firedDayP90', 'firedFrac@0', 'firedDayP50@0', 'firedFrac@90', 'firedDayP50@90'])
}
