import { describe, it, expect } from 'vitest'
import {
  leverConfigSchema,
  leverConfigPatchSchema,
  leverConfigInvariantViolation,
  defaultLeverConfig,
} from './lever-config'

describe('leverConfigSchema', () => {
  it('parses an empty object into the neutral-prior defaults', () => {
    expect(defaultLeverConfig).toEqual({
      minSamplePerArm: 30,
      rewardWindowDays: 14,
      reward: { meetingRequest: 1, positiveReply: 1, neutralReply: 0.5, negativeReply: 0 },
      priorStrength: 25,
      explorationShare: 0.2,
      archiveThreshold: 0.05,
      targetActiveArms: 3,
      maxActiveArms: 4,
      targetActiveStrategies: 3,
      maxActiveStrategies: 6,
      messageWeightFloor: 0.1,
      strategyWeightFloor: 0.1,
      stagnationTicks: 7,
      futilitySurvivalRate: 0.01,
      futilityConfidence: 0.99,
      futilityMinSends: 100,
    })
  })

  it('rejects an exploration share outside [0, 1] and a reward weight above 1', () => {
    expect(() => leverConfigSchema.parse({ explorationShare: 1.5 })).toThrow()
    expect(() => leverConfigSchema.parse({ reward: { positiveReply: 1.5 } })).toThrow()
  })

  it('merges a partial override with the defaults', () => {
    const cfg = leverConfigSchema.parse({ minSamplePerArm: 50, reward: { neutralReply: 1 } })
    expect(cfg.minSamplePerArm).toBe(50)
    expect(cfg.messageWeightFloor).toBe(0.1)
    expect(cfg.reward.neutralReply).toBe(1)
    expect(cfg.reward.meetingRequest).toBe(1)
  })

  it('rejects a weight floor outside [0, 1]', () => {
    expect(() => leverConfigSchema.parse({ messageWeightFloor: 1.5 })).toThrow()
    expect(() => leverConfigSchema.parse({ messageWeightFloor: -0.1 })).toThrow()
  })

  it('rejects a non-positive minimum sample', () => {
    expect(() => leverConfigSchema.parse({ minSamplePerArm: 0 })).toThrow()
  })

  it('leaves rewardLookbackDays absent by default (off = forgetting disabled)', () => {
    expect('rewardLookbackDays' in defaultLeverConfig).toBe(false)
    expect(leverConfigSchema.parse({ rewardLookbackDays: 60 }).rewardLookbackDays).toBe(60)
  })

  it('rejects a non-positive lookback window', () => {
    expect(() => leverConfigSchema.parse({ rewardLookbackDays: 0 })).toThrow()
  })

  it('leaves measurementsSince absent by default (no epoch cut)', () => {
    expect('measurementsSince' in defaultLeverConfig).toBe(false)
    expect(leverConfigSchema.parse({ measurementsSince: '2026-08-27' }).measurementsSince).toBe('2026-08-27')
  })

  it('rejects a non-date measurementsSince', () => {
    expect(() => leverConfigSchema.parse({ measurementsSince: 'not-a-date' })).toThrow()
    expect(() => leverConfigSchema.parse({ measurementsSince: '2026-08-27T00:00:00Z' })).toThrow()
  })
})

describe('leverConfigInvariantViolation (write-path cross-field guard)', () => {
  const effective = (over: Record<string, number>) => leverConfigSchema.parse(over)

  it('defaults are valid', () => {
    expect(leverConfigInvariantViolation(defaultLeverConfig)).toBeNull()
  })

  it('flags a variant target above its cap (cap lowered under the default target)', () => {
    expect(leverConfigInvariantViolation(effective({ maxActiveArms: 2 }))).toContain('targetActiveArms')
  })

  it('flags a strategy target above its cap', () => {
    expect(leverConfigInvariantViolation(effective({ targetActiveStrategies: 7 }))).toContain('targetActiveStrategies')
    expect(leverConfigInvariantViolation(effective({ maxActiveStrategies: 2 }))).toContain('targetActiveStrategies')
  })

  it('accepts target equal to the cap (boundary)', () => {
    expect(leverConfigInvariantViolation(effective({ targetActiveArms: 4, targetActiveStrategies: 6 }))).toBeNull()
  })
})

describe('leverConfigPatchSchema (overrides-only storage)', () => {
  it('stores only the fields the caller set — no defaults filled', () => {
    // The no-backfill property depends on this: an unset field must NOT be frozen
    // to today's default in the cell, so a later leverConfigSchema default change
    // still reaches the row via loadLeverConfig's read-time merge.
    expect(leverConfigPatchSchema.parse({ minSamplePerArm: 50 })).toEqual({ minSamplePerArm: 50 })
    expect(leverConfigPatchSchema.parse({})).toEqual({})
  })

  it('keeps a partial reward override sparse — nested weights are not frozen', () => {
    expect(leverConfigPatchSchema.parse({ reward: { neutralReply: 1 } })).toEqual({
      reward: { neutralReply: 1 },
    })
  })

  it('keeps rewardLookbackDays sparse', () => {
    expect(leverConfigPatchSchema.parse({ rewardLookbackDays: 60 })).toEqual({ rewardLookbackDays: 60 })
  })

  it('still enforces the field constraints', () => {
    expect(() => leverConfigPatchSchema.parse({ messageWeightFloor: 1.5 })).toThrow()
    expect(() => leverConfigPatchSchema.parse({ minSamplePerArm: 0 })).toThrow()
  })
})
