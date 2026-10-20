import { describe, it, expect } from 'vitest'
import { countPlacements, inboxTestDue, inboxTestHolds, judgeInboxTest, landedInSpam } from './inbox-test'

const result = (inbox: number, spam: number, missing = 0) => ({ testedAt: '2026-10-21T11:00:00.000Z', inbox, spam, missing })

describe('landedInSpam', () => {
  it('is spam when half or more of the delivered copies are', () => {
    expect(landedInSpam(result(2, 2))).toBe(true)
    expect(landedInSpam(result(0, 1))).toBe(true)
    expect(landedInSpam(result(3, 1))).toBe(false)
  })

  it('lets only delivered copies vote, and has no verdict when none arrived', () => {
    expect(landedInSpam(result(1, 0, 3))).toBe(false)
    expect(landedInSpam(result(0, 0, 4))).toBe(false)
  })
})

describe('inboxTestHolds', () => {
  it('holds on a spam result, and never without a result', () => {
    expect(inboxTestHolds(result(1, 3))).toBe(true)
    expect(inboxTestHolds(result(4, 0))).toBe(false)
    expect(inboxTestHolds(null)).toBe(false)
  })
})

describe('countPlacements', () => {
  it('counts each placement', () => {
    expect(countPlacements(['inbox', 'spam', 'missing', 'inbox'])).toEqual({ inbox: 2, spam: 1, missing: 1 })
  })
})

describe('judgeInboxTest', () => {
  const at = new Date('2026-10-22T10:00:00.000Z')

  it('judges on the copies that arrived', () => {
    expect(judgeInboxTest(['spam', 'spam', 'inbox', 'missing'], null, at)).toEqual({ testedAt: at.toISOString(), inbox: 1, spam: 2, missing: 1 })
  })

  it('judges nothing when no copy arrived or none could be read', () => {
    expect(judgeInboxTest(['missing', 'missing'], result(1, 3), at)).toBeNull()
    expect(judgeInboxTest([null, null], result(1, 3), at)).toBeNull()
  })

  it('lifts a hold on a partly read test only when the unread copies could not keep it in spam', () => {
    expect(judgeInboxTest(['inbox', null], result(1, 3), at)).toBeNull()
    expect(judgeInboxTest(['inbox', 'inbox', 'inbox', null], result(1, 3), at)).toMatchObject({ inbox: 3, spam: 0 })
  })

  it('holds on a partly read test that already landed in spam', () => {
    expect(judgeInboxTest(['spam', null, null], result(4, 0), at)).toMatchObject({ inbox: 0, spam: 1 })
  })
})

describe('inboxTestDue', () => {
  const now = new Date('2026-10-22T11:00:00.000Z')
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000)

  it('tests a sending mailbox once a day, counted from the last test sent', () => {
    expect(inboxTestDue(hoursAgo(2), null, null, now)).toBe(true)
    expect(inboxTestDue(hoursAgo(2), hoursAgo(22), result(4, 0), now)).toBe(false)
    expect(inboxTestDue(hoursAgo(2), hoursAgo(23), result(4, 0), now)).toBe(true)
  })

  it('stops testing a mailbox that stopped sending, unless the test holds it', () => {
    expect(inboxTestDue(hoursAgo(24 * 8), hoursAgo(24), result(4, 0), now)).toBe(false)
    expect(inboxTestDue(hoursAgo(24 * 8), hoursAgo(24), result(0, 4), now)).toBe(true)
  })
})
