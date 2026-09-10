import { describe, expect, it } from 'vitest'
import { daysToMask, isDue, isKnownTimezone, localTime, maskToDays, runKey } from './schedules'

const at = (iso: string) => new Date(iso)
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6] as const
const EVERY_DAY_MASK = 0b1111111

describe('day masks', () => {
  it('round-trips a set of days', () => {
    expect(maskToDays(daysToMask([1, 3, 5]))).toEqual([1, 3, 5])
  })

  it('covers the week', () => {
    expect(daysToMask(EVERY_DAY)).toBe(0b1111111)
    expect(maskToDays(0b1111111)).toEqual(EVERY_DAY)
  })
})

describe('localTime', () => {
  it('reads the wall clock of the zone, not UTC', () => {
    // 2026-03-10 23:30 UTC = 2026-03-11 08:30 in Tokyo (next day, Wednesday).
    expect(localTime(at('2026-03-10T23:30:00Z'), 'Asia/Tokyo')).toEqual({ dateKey: '2026-03-11', hour: 8, day: 3 })
  })

  it('follows a zone across its DST change', () => {
    // US DST starts 2026-03-08: 13:30 UTC is 08:30 EST before and 09:30 EDT after.
    expect(localTime(at('2026-03-07T13:30:00Z'), 'America/New_York').hour).toBe(8)
    expect(localTime(at('2026-03-09T13:30:00Z'), 'America/New_York').hour).toBe(9)
  })
})

describe('isDue', () => {
  const daily = { timezone: 'Asia/Tokyo', hour: 9, daysOfWeek: EVERY_DAY_MASK }

  it('is due within its local hour', () => {
    expect(isDue(daily, at('2026-03-11T00:00:00Z'))).toBe(true)
    expect(isDue(daily, at('2026-03-11T00:59:00Z'))).toBe(true)
  })

  it('is not due in another hour', () => {
    expect(isDue(daily, at('2026-03-11T01:00:00Z'))).toBe(false)
  })

  it('holds the local hour when the zone shifts', () => {
    const nine = { timezone: 'America/New_York', hour: 9, daysOfWeek: EVERY_DAY_MASK }
    expect(isDue(nine, at('2026-03-07T14:00:00Z'))).toBe(true) // EST
    expect(isDue(nine, at('2026-03-09T13:00:00Z'))).toBe(true) // EDT
    expect(isDue(nine, at('2026-03-09T14:00:00Z'))).toBe(false)
  })

  it('runs only on its days, read in its own zone', () => {
    // 2026-03-10T23:00Z is Tuesday in UTC and already Wednesday in Tokyo.
    const wednesday = { timezone: 'Asia/Tokyo', hour: 8, daysOfWeek: daysToMask([3]) }
    expect(isDue(wednesday, at('2026-03-10T23:00:00Z'))).toBe(true)
    const tuesday = { timezone: 'Asia/Tokyo', hour: 8, daysOfWeek: daysToMask([2]) }
    expect(isDue(tuesday, at('2026-03-10T23:00:00Z'))).toBe(false)
  })

  it('runs on weekdays only when asked', () => {
    const weekdays = { timezone: 'UTC', hour: 13, daysOfWeek: daysToMask([1, 2, 3, 4, 5]) }
    expect(isDue(weekdays, at('2026-03-13T13:00:00Z'))).toBe(true) // Friday
    expect(isDue(weekdays, at('2026-03-14T13:00:00Z'))).toBe(false) // Saturday
  })
})

describe('runKey', () => {
  it('is one key per local hour', () => {
    expect(runKey('Asia/Tokyo', at('2026-03-11T00:00:00Z'))).toBe('2026-03-11T09')
    expect(runKey('Asia/Tokyo', at('2026-03-11T00:59:00Z'))).toBe('2026-03-11T09')
    expect(runKey('Asia/Tokyo', at('2026-03-12T00:00:00Z'))).toBe('2026-03-12T09')
  })

  it('keeps one key for the hour a fall-back day repeats', () => {
    // 2026-11-01: America/New_York repeats 01:00 local (05:00 and 06:00 UTC);
    // the schedule runs once, not twice.
    expect(runKey('America/New_York', at('2026-11-01T05:30:00Z'))).toBe('2026-11-01T01')
    expect(runKey('America/New_York', at('2026-11-01T06:30:00Z'))).toBe('2026-11-01T01')
  })
})

describe('isKnownTimezone', () => {
  it('accepts IANA names and refuses anything else', () => {
    expect(isKnownTimezone('Asia/Tokyo')).toBe(true)
    expect(isKnownTimezone('UTC')).toBe(true)
    expect(isKnownTimezone('Mars/Olympus')).toBe(false)
    expect(isKnownTimezone('')).toBe(false)
  })
})
