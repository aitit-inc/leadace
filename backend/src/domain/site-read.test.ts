import { describe, expect, it } from 'vitest'
import { isSiteReadStale, signalsAfter, siteReadPatch, withRecentSignals } from './site-read'

const now = new Date('2026-09-12T00:00:00Z')

describe('isSiteReadStale', () => {
  it('is stale when never read or read more than 30 days ago', () => {
    expect(isSiteReadStale(null, now)).toBe(true)
    expect(isSiteReadStale('2026-08-12T23:59:59Z', now)).toBe(true)
  })
  it('is fresh within 30 days', () => {
    expect(isSiteReadStale('2026-08-13T00:00:00Z', now)).toBe(false)
  })
})

describe('siteReadPatch', () => {
  it('stamps when the write carries timingSignals, even an empty array', () => {
    expect(siteReadPatch({ timingSignals: [] }, now)).toEqual({ siteReadAt: now })
    expect(siteReadPatch({ timingSignals: ['2026-09-01: Opened a Berlin office.'] }, now)).toEqual({ siteReadAt: now })
  })
  it('leaves the column alone when timingSignals is omitted or there is no hypothesis', () => {
    expect(siteReadPatch({}, now)).toEqual({})
    expect(siteReadPatch(null, now)).toEqual({})
    expect(siteReadPatch(undefined, now)).toEqual({})
  })
})

describe('withRecentSignals', () => {
  it('appends a section and replaces an existing one', () => {
    const first = withRecentSignals('Acme makes widgets.', ['2026-09-01: Opened a Berlin office. (acme.example)'])
    expect(first).toBe('Acme makes widgets.\n\n## Recent Signals\n- 2026-09-01: Opened a Berlin office. (acme.example)')
    expect(withRecentSignals(first, ['2026-09-10: Hired a CRO. (acme.example)'])).toBe('Acme makes widgets.\n\n## Recent Signals\n- 2026-09-10: Hired a CRO. (acme.example)')
  })
  it('drops the section when there is nothing to list', () => {
    expect(withRecentSignals('Acme makes widgets.\n\n## Recent Signals\n- 2026-06-01: old', [])).toBe('Acme makes widgets.')
  })
})

describe('signalsAfter', () => {
  const overview = 'Acme.\n\n## Recent Signals\n- 2026-08-30: Opened an office.\n- 2026-09-05: Hired a CRO.\nnot a bullet'
  it('keeps only signals dated after the given day', () => {
    expect(signalsAfter(overview, '2026-08-30T15:00:00.000Z')).toEqual(['2026-09-05: Hired a CRO.'])
    expect(signalsAfter(overview, '2026-08-01')).toHaveLength(2)
  })
  it('is empty without a section', () => {
    expect(signalsAfter('Acme.', '2026-01-01')).toEqual([])
  })
})
