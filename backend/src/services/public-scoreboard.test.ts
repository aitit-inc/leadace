import { describe, expect, it } from 'vitest'
import { buildDaily, daysActiveSince } from './public-scoreboard'

const now = new Date('2026-09-02T10:30:00Z')

describe('buildDaily', () => {
  it('fills every UTC day of the window, oldest first, ending today', () => {
    const days = buildDaily(
      [{ day: '2026-09-02', count: '3' }, { day: '2026-08-30', count: 5 }],
      [{ day: '2026-08-30', count: 1 }],
      now,
      4,
    )
    expect(days).toEqual([
      { date: '2026-08-30', sent: 5, replies: 1 },
      { date: '2026-08-31', sent: 0, replies: 0 },
      { date: '2026-09-01', sent: 0, replies: 0 },
      { date: '2026-09-02', sent: 3, replies: 0 },
    ])
  })

  it('ignores rows outside the window', () => {
    const days = buildDaily([{ day: '2026-08-01', count: 9 }], [], now, 2)
    expect(days.map((d) => d.sent)).toEqual([0, 0])
  })
})

describe('daysActiveSince', () => {
  it('counts the first day as day 1', () => {
    expect(daysActiveSince('2026-09-02', now)).toBe(1)
    expect(daysActiveSince('2026-06-11', now)).toBe(84)
  })

  it('is 0 before the first send or on garbage input', () => {
    expect(daysActiveSince(null, now)).toBe(0)
    expect(daysActiveSince('nope', now)).toBe(0)
  })
})
