import { describe, it, expect } from 'vitest'
import {
  aggregateByCoarse,
  computeChannelAffinity,
  type ChannelFineStat,
  type ChannelCoarseStat,
} from './channel-affinity'
import { defaultLeverConfig, type LeverConfig } from './lever-config'

const cfg = (over: Partial<LeverConfig> = {}): LeverConfig => ({ ...defaultLeverConfig, ...over })

describe('aggregateByCoarse', () => {
  it('sums two fine industries that share a coarse bucket + channel', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: 'B2B SaaS', total: 40, responses: 4 },
      { channel: 'email', industry: 'AI / ML', total: 60, responses: 9 },
    ]
    expect(aggregateByCoarse(rows)).toEqual([
      { channel: 'email', coarse: 'software_tech', total: 100, responses: 13 },
    ])
  })

  it('keeps different channels and different buckets separate', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: 'B2B SaaS', total: 10, responses: 1 },
      { channel: 'form', industry: 'B2B SaaS', total: 20, responses: 2 },
      { channel: 'email', industry: 'Manufacturing', total: 30, responses: 3 },
    ]
    const out = aggregateByCoarse(rows)
    expect(out).toHaveLength(3)
    expect(out).toContainEqual({ channel: 'form', coarse: 'software_tech', total: 20, responses: 2 })
    expect(out).toContainEqual({ channel: 'email', coarse: 'hardware_industrial', total: 30, responses: 3 })
  })

  it('folds null / unknown industry into other', () => {
    const rows: ChannelFineStat[] = [
      { channel: 'email', industry: null, total: 10, responses: 1 },
      { channel: 'email', industry: 'made up', total: 5, responses: 0 },
    ]
    expect(aggregateByCoarse(rows)).toEqual([
      { channel: 'email', coarse: 'other', total: 15, responses: 1 },
    ])
  })
})

describe('computeChannelAffinity', () => {
  it('empty input → empty map', () => {
    expect(computeChannelAffinity([], cfg())).toEqual({})
  })

  it('drops channels under min-sample; omits a bucket with none mature', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 29, responses: 10 },
      { channel: 'form', coarse: 'software_tech', total: 10, responses: 5 },
    ]
    expect(computeChannelAffinity(stats, cfg())).toEqual({})
  })

  it('ranks mature channels by Wilson lower bound within a bucket', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 100, responses: 20 }, // 20%
      { channel: 'form', coarse: 'software_tech', total: 100, responses: 8 }, //  8%
      { channel: 'sns_linkedin', coarse: 'software_tech', total: 50, responses: 1 }, //  2%
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['software_tech']!.map((r) => r.channel)).toEqual(['email', 'form', 'sns_linkedin'])
    expect(out['software_tech']![0]).toMatchObject({ channel: 'email', rate: 20, total: 100, responses: 20 })
  })

  it('Wilson lower keeps a tiny-n high-rate channel from outranking a solid one', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'services', total: 30, responses: 12 }, // 40% but n=30
      { channel: 'form', coarse: 'services', total: 400, responses: 120 }, // 30% but n=400
    ]
    const out = computeChannelAffinity(stats, cfg())
    // form's lower bound (~25.8%) beats email's (~24.5%) despite the lower raw rate.
    expect(out['services']!.map((r) => r.channel)).toEqual(['form', 'email'])
  })

  it('surfaces a single mature channel as the measured preference', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'services', total: 50, responses: 10 },
      { channel: 'form', coarse: 'services', total: 5, responses: 3 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['services']).toEqual([{ channel: 'email', rate: 20, total: 50, responses: 10 }])
  })

  it('keeps buckets independent', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'email', coarse: 'software_tech', total: 100, responses: 5 },
      { channel: 'form', coarse: 'software_tech', total: 100, responses: 15 },
      { channel: 'email', coarse: 'services', total: 100, responses: 30 },
      { channel: 'form', coarse: 'services', total: 100, responses: 10 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['software_tech']!.map((r) => r.channel)).toEqual(['form', 'email'])
    expect(out['services']!.map((r) => r.channel)).toEqual(['email', 'form'])
  })

  it('deterministic channel-name tie-break on identical stats', () => {
    const stats: ChannelCoarseStat[] = [
      { channel: 'form', coarse: 'other', total: 100, responses: 10 },
      { channel: 'email', coarse: 'other', total: 100, responses: 10 },
    ]
    const out = computeChannelAffinity(stats, cfg())
    expect(out['other']!.map((r) => r.channel)).toEqual(['email', 'form'])
  })
})
