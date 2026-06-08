import { describe, it, expect } from 'vitest'
import { csvRowToInput, validateCsvHeader } from './prospect-import'

const FULL_HEADER = [
  'organizationDomain',
  'organizationName',
  'organizationWebsiteUrl',
  'name',
  'overview',
  'websiteUrl',
  'email',
  'priority',
  'doNotContact',
  'snsAccounts.x',
]
const baseRow = (over: Partial<Record<string, string>> = {}): string[] => {
  const cells: Record<string, string> = {
    organizationDomain: 'example.com',
    organizationName: 'Example Inc',
    organizationWebsiteUrl: 'https://example.com',
    name: 'Sales Dept',
    overview: 'A company that does things',
    websiteUrl: 'https://example.com/sales',
    email: 'foo@example.com',
    priority: '2',
    doNotContact: '',
    'snsAccounts.x': '',
    ...over,
  }
  return FULL_HEADER.map((h) => cells[h] ?? '')
}

describe('csvRowToInput', () => {
  it('parses a complete valid row, folding snsAccounts.* and coercing priority', () => {
    const r = csvRowToInput(FULL_HEADER, baseRow({ 'snsAccounts.x': 'foohandle' }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.priority).toBe(2)
    expect(r.value.email).toBe('foo@example.com')
    expect(r.value.snsAccounts).toEqual({ x: 'foohandle' })
  })

  it('coerces doNotContact truthy vocabulary to true', () => {
    for (const v of ['1', 'true', 'YES', 'On']) {
      const r = csvRowToInput(FULL_HEADER, baseRow({ doNotContact: v }))
      expect(r.ok && r.value.doNotContact).toBe(true)
    }
  })

  it('coerces doNotContact falsy vocabulary to false (does not silently treat as true)', () => {
    for (const v of ['0', 'false', 'NO', 'Off']) {
      const r = csvRowToInput(FULL_HEADER, baseRow({ doNotContact: v }))
      expect(r.ok).toBe(true)
      expect(r.ok && r.value.doNotContact).toBe(false)
    }
  })

  it('rejects an unrecognized doNotContact value rather than guessing', () => {
    const r = csvRowToInput(FULL_HEADER, baseRow({ doNotContact: 'maybe' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/doNotContact/)
  })

  it('rejects a non-integer priority', () => {
    const r = csvRowToInput(FULL_HEADER, baseRow({ priority: 'high' }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/priority/)
  })

  it('fails schema validation when a required field is blank', () => {
    const r = csvRowToInput(FULL_HEADER, baseRow({ name: '' }))
    expect(r.ok).toBe(false)
  })
})

describe('validateCsvHeader', () => {
  it('accepts a header with all required columns and only allowed extras', () => {
    expect(validateCsvHeader(FULL_HEADER, false)).toEqual({ ok: true })
  })

  it('flags a missing required column', () => {
    const header = FULL_HEADER.filter((h) => h !== 'overview')
    const r = validateCsvHeader(header, false)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('Missing required columns')
      expect(r.detail).toContain('overview')
    }
  })

  it('flags an unknown column', () => {
    const r = validateCsvHeader([...FULL_HEADER, 'bogusColumn'], false)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('Unknown columns')
      expect(r.detail).toContain('bogusColumn')
    }
  })

  it('requires matchReason when a project is targeted', () => {
    const withoutReason = FULL_HEADER
    expect(validateCsvHeader(withoutReason, false)).toEqual({ ok: true })
    const r = validateCsvHeader(withoutReason, true)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.detail).toContain('matchReason')
    expect(validateCsvHeader([...withoutReason, 'matchReason'], true)).toEqual({ ok: true })
  })
})
