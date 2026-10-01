import { describe, it, expect } from 'vitest'
import { optionOps } from './change'

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
