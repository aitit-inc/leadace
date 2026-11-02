import { describe, it, expect } from 'vitest'
import { authorOf, optionOps, reachDiff, reachLine, sendingDiff } from './change'

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

describe('authorOf', () => {
  it('credits the person for what they did or asked for, and keeps MCP and unattended runs as Ace', () => {
    expect(authorOf('ui', 'r')).toEqual({ actor: 'user', reason: 'r' })
    expect(authorOf('chat', 'r', ['replies'])).toEqual({ actor: 'user', reason: 'r' })
    expect(authorOf('mcp', 'r')).toEqual({ actor: 'ace', reason: 'r', evidence: null })
    expect(authorOf('cron', 'r', ['replies', 'replies'])).toEqual({ actor: 'ace', reason: 'r', evidence: { signals: ['replies'] } })
  })
})

describe('sendingDiff', () => {
  const before = { outboundMode: 'draft', dailyNewProspects: null, followUps: false } as const

  it('holds only what really changed', () => {
    expect(sendingDiff(before, { outboundMode: 'draft', dailyNewProspects: null, followUps: false })).toEqual({})
    expect(sendingDiff(before, { outboundMode: 'send', dailyNewProspects: 10 })).toEqual({
      outboundMode: { from: 'draft', to: 'send' },
      dailyNewProspects: { from: null, to: 10 },
    })
  })
})

describe('reachLine', () => {
  it('says what decides how much goes out', () => {
    expect(reachLine({ followUps: { from: false, to: true }, dailyNewProspects: { from: 20, to: null } })).toBe('New prospects a day: 20 → default; Follow-ups: off → on')
  })
})
