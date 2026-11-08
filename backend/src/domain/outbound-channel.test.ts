import { describe, expect, it } from 'vitest'
import { contactDecision } from './outbound-channel'

describe('contactDecision', () => {
  const none = { email: null, form: null, x: false, linkedin: false }
  it('registers a candidate reachable on a channel the project uses', () => {
    expect(contactDecision({ ...none, email: 'usable' }, ['email'])).toBe('reachable')
    expect(contactDecision({ ...none, form: 'usable' }, ['email', 'form'])).toBe('reachable')
  })
  it('skips a candidate reachable only on channels the project turned off', () => {
    expect(contactDecision({ ...none, form: 'usable', x: true }, ['email'])).toBe('channel_not_enabled')
  })
  it('keeps a refusal even when nothing is reachable', () => {
    expect(contactDecision({ ...none, email: 'refused', form: 'usable' }, ['email'])).toBe('refusal')
  })
  it('finds nothing when the site shows no channel', () => {
    expect(contactDecision(none, ['email', 'form'])).toBe('none')
  })
})
