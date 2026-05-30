import { describe, it, expect } from 'vitest'
import { parseSummaryJson } from './inquiry-summarize'

describe('parseSummaryJson', () => {
  it('parses a plain JSON object', () => {
    expect(parseSummaryJson('{"summary":"All good","outcome":"lead"}')).toEqual({ summary: 'All good', outcome: 'lead' })
  })

  it('strips ```json code fences before parsing', () => {
    const raw = '```json\n{"summary":"Wrapped","outcome":"inquired"}\n```'
    expect(parseSummaryJson(raw)).toEqual({ summary: 'Wrapped', outcome: 'inquired' })
  })

  it('defaults any non-"lead" outcome to the conservative "inquired"', () => {
    expect(parseSummaryJson('{"summary":"x","outcome":"escalate"}')?.outcome).toBe('inquired')
    expect(parseSummaryJson('{"summary":"x"}')?.outcome).toBe('inquired')
  })

  it('returns null on an empty/whitespace summary', () => {
    expect(parseSummaryJson('{"summary":"   ","outcome":"lead"}')).toBeNull()
    expect(parseSummaryJson('{"outcome":"lead"}')).toBeNull()
  })

  it('returns null on invalid JSON or a non-object', () => {
    expect(parseSummaryJson('not json')).toBeNull()
    expect(parseSummaryJson('"just a string"')).toBeNull()
    expect(parseSummaryJson('null')).toBeNull()
  })
})
