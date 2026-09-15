import { describe, it, expect } from 'vitest'
import { classifyGoogleTokenRejection } from './google-token'

describe('classifyGoogleTokenRejection', () => {
  it('reads invalid_grant as a revoked grant', () => {
    expect(
      classifyGoogleTokenRejection(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })),
    ).toBe('revoked')
  })

  it('reads admin_policy_enforced as blocked by the Workspace admin', () => {
    expect(classifyGoogleTokenRejection(JSON.stringify({ error: 'admin_policy_enforced' }))).toBe('blocked')
  })

  it('reads client and request errors as our misconfiguration', () => {
    for (const error of ['invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type']) {
      expect(classifyGoogleTokenRejection(JSON.stringify({ error }))).toBe('misconfigured')
    }
  })

  it('reads an unknown code or a code in another case as misconfigured', () => {
    expect(classifyGoogleTokenRejection(JSON.stringify({ error: 'something_new' }))).toBe('misconfigured')
    expect(classifyGoogleTokenRejection(JSON.stringify({ error: 'INVALID_GRANT' }))).toBe('misconfigured')
  })

  it('reads a malformed body as misconfigured', () => {
    expect(classifyGoogleTokenRejection('<html>Bad Request</html>')).toBe('misconfigured')
    expect(classifyGoogleTokenRejection(JSON.stringify({ error: { code: 400 } }))).toBe('misconfigured')
    expect(classifyGoogleTokenRejection(JSON.stringify({ error_description: 'invalid_grant' }))).toBe('misconfigured')
  })
})
