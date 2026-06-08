import type { Channel } from '../db/schema'
import type { LeverConfig } from './lever-config'
import { coarseIndustry, type CoarseIndustry } from './coarse-industry'
import { wilsonBounds } from './subject-bandit'

export type ChannelFineStat = {
  channel: Channel
  industry: string | null
  total: number
  responses: number
}

export type ChannelCoarseStat = {
  channel: Channel
  coarse: CoarseIndustry
  total: number
  responses: number
}

// Array order is the ranking; rate/total/responses are for transparency only.
export type ChannelRank = {
  channel: Channel
  rate: number
  total: number
  responses: number
}

// An absent bucket means "no measured preference, use policy order".
export type ChannelAffinityMap = Partial<Record<CoarseIndustry, ChannelRank[]>>

export function aggregateByCoarse(rows: ChannelFineStat[]): ChannelCoarseStat[] {
  const byKey = new Map<string, ChannelCoarseStat>()
  for (const r of rows) {
    const coarse = coarseIndustry(r.industry)
    const key = `${r.channel} ${coarse}`
    const entry = byKey.get(key)
    if (entry) {
      entry.total += r.total
      entry.responses += r.responses
    } else {
      byKey.set(key, { channel: r.channel, coarse, total: r.total, responses: r.responses })
    }
  }
  return Array.from(byKey.values())
}

// Ranked by Wilson lower bound, not raw rate, so a high rate on tiny n does not
// outrank a solid one. Channels under min-sample drop; an empty bucket is omitted.
export function computeChannelAffinity(
  stats: ChannelCoarseStat[],
  config: LeverConfig,
): ChannelAffinityMap {
  const byBucket = new Map<CoarseIndustry, ChannelCoarseStat[]>()
  for (const s of stats) {
    if (s.total < config.minSamplePerArm) continue
    const list = byBucket.get(s.coarse)
    if (list) list.push(s)
    else byBucket.set(s.coarse, [s])
  }

  const out: ChannelAffinityMap = {}
  for (const [coarse, list] of byBucket) {
    out[coarse] = [...list]
      .sort((a, b) => {
        const la = wilsonBounds(a.responses, a.total).lower
        const lb = wilsonBounds(b.responses, b.total).lower
        if (lb !== la) return lb - la
        const ra = a.responses / a.total
        const rb = b.responses / b.total
        if (rb !== ra) return rb - ra
        return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0
      })
      .map((s) => ({
        channel: s.channel,
        rate: Math.round((s.responses / s.total) * 1000) / 10,
        total: s.total,
        responses: s.responses,
      }))
  }
  return out
}
