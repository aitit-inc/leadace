import { describe, it, expect } from 'vitest'
import { pickProjectMatch } from './projects'

describe('pickProjectMatch', () => {
  it('resolves by id', () => {
    const rows = [{ id: 'abc123', name: 'Acme Outreach' }]
    expect(pickProjectMatch(rows, 'abc123')).toBe('abc123')
  })

  it('resolves by name', () => {
    const rows = [{ id: 'abc123', name: 'Acme Outreach' }]
    expect(pickProjectMatch(rows, 'Acme Outreach')).toBe('abc123')
  })

  it('prefers the id match when another project is named with that id', () => {
    const rows = [
      { id: 'xyz789', name: 'abc123' },
      { id: 'abc123', name: 'Acme Outreach' },
    ]
    expect(pickProjectMatch(rows, 'abc123')).toBe('abc123')
  })

  it('returns null when nothing matches', () => {
    expect(pickProjectMatch([], 'missing')).toBeNull()
  })
})
