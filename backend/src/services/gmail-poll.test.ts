import { describe, it, expect } from 'vitest'
import { gmailAfter } from './gmail-poll'

// Gmail search wants `after:YYYY/M/D` in UTC, NOT zero-padded — distinct from the
// IMAP `D-Mon-YYYY` form (domain/imap imapSearchDate). A wrong format makes Gmail
// silently ignore the date filter, widening or voiding the poll window.
describe('gmailAfter', () => {
  it('formats UTC year/month/day with no zero-padding', () => {
    expect(gmailAfter(new Date('2026-01-05T23:00:00Z'))).toBe('2026/1/5')
    expect(gmailAfter(new Date('2026-12-31T12:00:00Z'))).toBe('2026/12/31')
  })

  it('uses UTC components, not local time', () => {
    expect(gmailAfter(new Date('2026-03-09T23:30:00Z'))).toBe('2026/3/9')
  })

  it('passes a leap day through', () => {
    expect(gmailAfter(new Date('2028-02-29T00:00:00Z'))).toBe('2028/2/29')
  })
})
