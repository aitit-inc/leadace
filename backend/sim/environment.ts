// The subjects under test are the production domain functions imported below;
// this loop only replays the service-layer orchestration and is valid while
// these mirrors of backend/src/services hold:
// - tick (levers.ts): computeArmWeights over active slugs, archives applied
//   immediately, ordering scores materialized into the whole standing pool;
//   rows registered after the tick keep the schema default 1.0 until the next
//   tick. Vitals rng re-seeded with the same string every tick (not date-keyed).
// - inflow (getLeverStateById + build-list): floor-rescued largest-remainder
//   plan; shortfall stays unfilled.
// - outflow (prospects.ts): exploit lane = ORDER BY ordering_score DESC,
//   createdAt ASC; explore lane = drawExploreSlots incl. the '*' unattributed
//   stratum (archived-slug rows land there), stratum shortfall falls back to
//   a fully random draw. No strategy stagnation rotation (#357 deferral), no
//   replenishment (the LLM side is out of simulation scope).

import {
  computeArmWeights,
  floorRescuedWeights,
  seededRng,
  type ArmStat,
} from '../src/domain/arm-bandit'
import { assessVitals, type VitalsVerdict } from '../src/domain/vital-signs'
import { apportionLargestRemainder, drawExploreSlots } from '../src/domain/discovery-allocation'
import {
  computeAxisLifts,
  overallMeanReward,
  type TargetingAxisStat,
} from '../src/domain/targeting-score'
import type { LeverConfig } from '../src/domain/lever-config'

export type StrategyTruth = {
  // Ground-truth P(countable reply | delivered); deliveryFactor multiplies it.
  replyRate: number
  slug: string
  inventory: number
  seedPool?: number
  seedHistory?: { total: number; replies: number }
}

export type Scenario = {
  name: string
  strategies: StrategyTruth[]
  bounceRate: number
  deliveryFactor: number
  sendsPerDay: number
  batchSize: number
  horizonDays: number
}

export type DayRecord = {
  day: number
  weights: Record<string, number>
  archived: string[]
  sendsBySlug: Record<string, number>
  // Snapshot after this day's maturation step; bounces already excluded.
  matureTotals: Record<string, number>
  registrationShortfall: number
  vitalsVerdict: VitalsVerdict
  vitalsPDead: number
  matureSends: number
  matureReplies: number
}

export type RunResult = {
  scenario: string
  seed: number
  days: DayRecord[]
  archivedAt: Record<string, number>
  // Noise-free ground-truth expectation of the chosen sends; the bandit
  // itself only ever sees the noisy draws.
  cumulativeExpected: number[]
  cumulativeSends: number[]
}

export type SimParams = {
  config: LeverConfig
  // Production runs computePBest/assessVitals at 10k; 500–1k keeps the sweep
  // tractable.
  mcSamples: number
}

const UNATTRIBUTED_STRATUM = '*'

// Sequence order stands in for createdAt.
type SeqQueue = { seqs: number[]; head: number }

const queueSize = (q: SeqQueue): number => q.seqs.length - q.head

const compact = (q: SeqQueue): void => {
  if (q.head > 1024 && q.head * 2 > q.seqs.length) {
    q.seqs = q.seqs.slice(q.head)
    q.head = 0
  }
}

const popOldest = (q: SeqQueue): void => {
  q.head += 1
  compact(q)
}

const popRandom = (q: SeqQueue, rng: () => number): void => {
  const idx = q.head + Math.floor(rng() * queueSize(q))
  if (idx === q.head) q.head += 1
  else q.seqs.splice(idx, 1)
  compact(q)
}

// `scored` rows carry the score the last tick materialized; `fresh` rows
// registered since then sit at the schema default 1.0 until the next tick
// merges them in.
type SlugPool = { scored: SeqQueue; scoredScore: number; fresh: SeqQueue }

const slugPoolSize = (p: SlugPool): number => queueSize(p.scored) + queueSize(p.fresh)

export function runScenario(scenario: Scenario, seed: number, params: SimParams): RunResult {
  const { config, mcSamples } = params
  const truth = new Map(scenario.strategies.map((s) => [s.slug, s]))
  const envRng = seededRng(`env:${scenario.name}:${seed}`)

  const active = new Set(scenario.strategies.map((s) => s.slug))
  const archivedAt: Record<string, number> = {}
  const inventory = new Map(scenario.strategies.map((s) => [s.slug, s.inventory]))
  const stats = new Map(
    scenario.strategies.map((s) => [
      s.slug,
      { total: s.seedHistory?.total ?? 0, replies: s.seedHistory?.replies ?? 0 },
    ]),
  )
  let matureSends = 0
  let matureReplies = 0
  for (const s of stats.values()) {
    matureSends += s.total
    matureReplies += s.replies
  }

  let seq = 0
  const pool = new Map<string, SlugPool>(
    scenario.strategies.map((s) => {
      const fresh: SeqQueue = { seqs: [], head: 0 }
      for (let i = 0; i < (s.seedPool ?? 0); i++) fresh.seqs.push(seq++)
      return [s.slug, { scored: { seqs: [], head: 0 }, scoredScore: 1, fresh }]
    }),
  )
  const allSlugs = [...pool.keys()].sort()
  const poolTotal = (): number => {
    let acc = 0
    for (const p of pool.values()) acc += slugPoolSize(p)
    return acc
  }
  const drawFromPools = (slugs: string[], rng: () => number): string | null => {
    let total = 0
    for (const s of slugs) total += slugPoolSize(pool.get(s)!)
    if (total <= 0) return null
    let target = rng() * total
    for (const s of slugs) {
      target -= slugPoolSize(pool.get(s)!)
      if (target < 0) return s
    }
    return slugs[slugs.length - 1]!
  }

  let storedWeights: Record<string, number> = {}
  const pending: { sentDay: number; slug: string; bounced: boolean; replied: boolean }[] = []

  const days: DayRecord[] = []
  const cumulativeExpected: number[] = []
  const cumulativeSends: number[] = []
  let expectedAcc = 0
  let sendsAcc = 0

  for (let day = 0; day < scenario.horizonDays; day++) {
    while (pending.length > 0 && day - pending[0]!.sentDay >= config.rewardWindowDays) {
      const send = pending.shift()!
      if (send.bounced) continue
      const s = stats.get(send.slug)!
      s.total += 1
      if (send.replied) s.replies += 1
      matureSends += 1
      if (send.replied) matureReplies += 1
    }

    const activeSlugs = [...active].sort()
    const arms: ArmStat[] = activeSlugs.map((slug) => ({
      armId: slug,
      total: stats.get(slug)!.total,
      rewardSum: stats.get(slug)!.replies,
    }))
    const decision = computeArmWeights(
      arms,
      {
        minSamplePerArm: config.minSamplePerArm,
        archiveThreshold: config.archiveThreshold,
        weightFloor: config.strategyWeightFloor,
      },
      seededRng(`${day}:${seed}:discovery`),
      mcSamples,
    )
    const archivedToday: string[] = []
    for (const a of decision.toArchive) {
      active.delete(a.armId)
      archivedAt[a.armId] = day
      archivedToday.push(a.armId)
    }
    storedWeights = decision.weights

    const axisStats: TargetingAxisStat[] = [...stats]
      .filter(([, s]) => s.total > 0)
      .map(([slug, s]) => ({ value: slug, total: s.total, rewardSum: s.replies }))
    const r0 = overallMeanReward(axisStats)
    const lifts = new Map(
      computeAxisLifts(axisStats, r0, config.priorStrength).map((l) => [l.value as string, l.lift]),
    )
    for (const [slug, p] of pool) {
      if (queueSize(p.fresh) > 0) {
        p.scored.seqs = [...p.scored.seqs.slice(p.scored.head), ...p.fresh.seqs.slice(p.fresh.head)]
        p.scored.head = 0
        p.fresh = { seqs: [], head: 0 }
      }
      p.scoredScore = lifts.get(slug) ?? 1
    }

    const vitals = assessVitals(
      { sends: matureSends, replies: matureReplies },
      config,
      seededRng(`vitals:${seed}`),
      mcSamples,
    )

    const activeNow = [...active].sort()
    let registrationShortfall = 0
    if (activeNow.length > 0) {
      let planWeights = floorRescuedWeights(activeNow, storedWeights, config.strategyWeightFloor)
      if (Object.values(planWeights).reduce((acc, w) => acc + w, 0) <= 0) {
        planWeights = Object.fromEntries(activeNow.map((slug) => [slug, 1]))
      }
      for (const { slug, count } of apportionLargestRemainder(planWeights, scenario.batchSize)) {
        const take = Math.min(count, inventory.get(slug)!)
        inventory.set(slug, inventory.get(slug)! - take)
        const fresh = pool.get(slug)!.fresh
        for (let i = 0; i < take; i++) fresh.seqs.push(seq++)
        registrationShortfall += count - take
      }
    }

    const sendsBySlug: Record<string, number> = {}
    const send = (slug: string): void => {
      const t = truth.get(slug)!
      const bounced = envRng() < scenario.bounceRate
      const replied = !bounced && envRng() < t.replyRate * scenario.deliveryFactor
      pending.push({ sentDay: day, slug, bounced, replied })
      sendsBySlug[slug] = (sendsBySlug[slug] ?? 0) + 1
      expectedAcc += (1 - scenario.bounceRate) * t.replyRate * scenario.deliveryFactor
      sendsAcc += 1
    }

    const exploreTarget = Math.floor(scenario.sendsPerDay * config.explorationShare)
    const topTarget = scenario.sendsPerDay - exploreTarget

    for (let i = 0; i < topTarget; i++) {
      let pick: { slug: string; queue: SeqQueue; score: number; oldest: number } | null = null
      for (const slug of allSlugs) {
        const p = pool.get(slug)!
        for (const [queue, score] of [
          [p.scored, p.scoredScore],
          [p.fresh, 1],
        ] as const) {
          if (queueSize(queue) === 0) continue
          const oldest = queue.seqs[queue.head]!
          if (pick === null || score > pick.score || (score === pick.score && oldest < pick.oldest)) {
            pick = { slug, queue, score, oldest }
          }
        }
      }
      if (pick === null) break
      popOldest(pick.queue)
      send(pick.slug)
    }

    const liveWeights = {
      ...floorRescuedWeights(activeNow, storedWeights, config.strategyWeightFloor),
      [UNATTRIBUTED_STRATUM]: config.strategyWeightFloor,
    }
    const slotCounts =
      exploreTarget > 0 ? drawExploreSlots(liveWeights, exploreTarget, envRng) : {}
    const takeRandomFrom = (slug: string): void => {
      const p = pool.get(slug)!
      const scoredSize = queueSize(p.scored)
      if (envRng() * slugPoolSize(p) < scoredSize) popRandom(p.scored, envRng)
      else popRandom(p.fresh, envRng)
      send(slug)
    }
    let exploreFilled = 0
    const inactiveSlugs = allSlugs.filter((slug) => !active.has(slug))
    for (const [slug, count] of Object.entries(slotCounts)) {
      for (let i = 0; i < count; i++) {
        const pick =
          slug === UNATTRIBUTED_STRATUM
            ? drawFromPools(inactiveSlugs, envRng)
            : slugPoolSize(pool.get(slug)!) > 0
              ? slug
              : null
        if (pick === null) continue
        takeRandomFrom(pick)
        exploreFilled += 1
      }
    }
    for (let i = exploreFilled; i < exploreTarget && poolTotal() > 0; i++) {
      const pick = drawFromPools(allSlugs, envRng)
      if (pick === null) break
      takeRandomFrom(pick)
    }

    days.push({
      day,
      weights: storedWeights,
      archived: archivedToday,
      sendsBySlug,
      matureTotals: Object.fromEntries([...stats].map(([slug, s]) => [slug, s.total])),
      registrationShortfall,
      vitalsVerdict: vitals.verdict,
      vitalsPDead: vitals.pDead,
      matureSends,
      matureReplies,
    })
    cumulativeExpected.push(expectedAcc)
    cumulativeSends.push(sendsAcc)
  }

  return { scenario: scenario.name, seed, days, archivedAt, cumulativeExpected, cumulativeSends }
}

// Knows the true rates, ignores registration cadence and maturation — an
// upper bound, not a reachable policy.
export function oracleTrajectory(scenario: Scenario): number[] {
  const supply = new Map(
    scenario.strategies.map((s) => [s.slug, s.inventory + (s.seedPool ?? 0)]),
  )
  const bySlugRate = [...scenario.strategies].sort((a, b) => b.replyRate - a.replyRate)
  const out: number[] = []
  let acc = 0
  for (let day = 0; day < scenario.horizonDays; day++) {
    let remaining = scenario.sendsPerDay
    for (const s of bySlugRate) {
      if (remaining === 0) break
      const take = Math.min(remaining, supply.get(s.slug)!)
      supply.set(s.slug, supply.get(s.slug)! - take)
      acc += take * (1 - scenario.bounceRate) * s.replyRate * scenario.deliveryFactor
      remaining -= take
    }
    out.push(acc)
  }
  return out
}
