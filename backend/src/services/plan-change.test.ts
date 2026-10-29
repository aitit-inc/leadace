import { describe, it, expect } from 'vitest'
import { nothingLeftToSwitch, planChangeDirection, scheduledPlanFromSchedule, type StripeSchedule } from './plan-change'

const phase = (plan: string) => ({
  start_date: 0,
  end_date: 1,
  items: [{ price: { id: `price_${plan}`, metadata: { plan } }, quantity: 1 }],
})

describe('planChangeDirection', () => {
  it('ranks starter < pro < scale', () => {
    expect(planChangeDirection('starter', 'scale')).toBe('upgrade')
    expect(planChangeDirection('scale', 'pro')).toBe('downgrade')
    expect(planChangeDirection('pro', 'pro')).toBe('same')
  })
})

describe('scheduledPlanFromSchedule', () => {
  it('reads the plan of the last phase when it differs from the running one', () => {
    const schedule: StripeSchedule = { id: 's', current_phase: { start_date: 0 }, phases: [phase('pro'), phase('starter')] }
    expect(scheduledPlanFromSchedule(schedule, 'pro')).toBe('starter')
  })
  it('is null without a schedule, for a single-phase schedule, and once the switch happened', () => {
    expect(scheduledPlanFromSchedule(null, 'pro')).toBeNull()
    expect(scheduledPlanFromSchedule({ id: 's', current_phase: { start_date: 0 }, phases: [phase('pro')] }, 'pro')).toBeNull()
    expect(scheduledPlanFromSchedule({ id: 's', current_phase: { start_date: 0 }, phases: [phase('pro'), phase('starter')] }, 'starter')).toBeNull()
  })
  it('ignores a last phase whose price carries no plan', () => {
    const schedule: StripeSchedule = { id: 's', current_phase: { start_date: 0 }, phases: [phase('pro'), { ...phase('x'), items: [{ price: { id: 'p', metadata: {} }, quantity: 1 }] }] }
    expect(scheduledPlanFromSchedule(schedule, 'pro')).toBeNull()
  })
})

describe('nothingLeftToSwitch', () => {
  const schedule = (...phases: StripeSchedule['phases']): StripeSchedule => ({ id: 's', current_phase: { start_date: 0 }, phases })
  it('is true when the last phase is the running plan', () => {
    expect(nothingLeftToSwitch(schedule(phase('pro')), 'pro')).toBe(true)
    expect(nothingLeftToSwitch(schedule(phase('pro'), phase('starter')), 'starter')).toBe(true)
  })
  it('is false for a pending switch and for a last phase whose price carries no plan', () => {
    expect(nothingLeftToSwitch(schedule(phase('pro'), phase('starter')), 'pro')).toBe(false)
    expect(nothingLeftToSwitch(schedule(phase('pro'), { ...phase('x'), items: [{ price: { id: 'p', metadata: {} }, quantity: 1 }] }), 'pro')).toBe(false)
  })
})
