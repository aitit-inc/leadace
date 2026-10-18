import { describe, it, expect } from 'vitest'
import { optionOps, reachDiff } from './change'

const state = (archived: boolean, subject: string | null = 's', label: string | null = null) => ({
  archived,
  content: { subject, label },
})

describe('optionOps', () => {
  it('adds a new option, and archives one created archived', () => {
    expect(optionOps(null, state(false))).toEqual(['add'])
    expect(optionOps(null, state(true))).toEqual(['add', 'archive'])
  })

  it('archives and restores on a state flip, even with an edit in the same write', () => {
    expect(optionOps(state(false), state(true, 'edited'))).toEqual(['archive'])
    expect(optionOps(state(true), state(false))).toEqual(['restore'])
  })

  it('updates when only the content changed, null included', () => {
    expect(optionOps(state(false, 's', null), state(false, 's', 'label'))).toEqual(['update'])
    expect(optionOps(state(false, 's'), state(false, null))).toEqual(['update'])
  })

  it('logs nothing when nothing changed', () => {
    expect(optionOps(state(true, 's', 'l'), state(true, 's', 'l'))).toEqual([])
  })
})

describe('reachDiff', () => {
  const before = { outboundChannels: ['email' as const], targetCountries: ['JP' as const], targetLanguage: 'ja' as const }

  it('keeps only the fields whose value changed, comparing lists as sets', () => {
    expect(reachDiff(before, { outboundChannels: ['form', 'email'], targetCountries: ['JP'], targetLanguage: 'ja' })).toEqual({
      outboundChannels: { from: ['email'], to: ['form', 'email'] },
    })
    expect(reachDiff(before, { targetLanguage: 'en' })).toEqual({ targetLanguage: { from: 'ja', to: 'en' } })
  })

  it('is empty when nothing changed', () => {
    expect(reachDiff(before, { outboundChannels: ['email'] })).toEqual({})
    expect(reachDiff(before, {})).toEqual({})
  })
})
