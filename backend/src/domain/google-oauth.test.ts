import { describe, it, expect } from 'vitest'
import { parseIdTokenEmail } from './google-oauth'

function idToken(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `eyJhbGciOiJSUzI1NiJ9.${payload}.sig`
}

describe('parseIdTokenEmail', () => {
  it('reads a verified email from the payload', () => {
    expect(parseIdTokenEmail(idToken({ email: 'sales@example.com', email_verified: true }))).toBe('sales@example.com')
  })

  it('accepts the string form of email_verified', () => {
    expect(parseIdTokenEmail(idToken({ email: 'sales@example.com', email_verified: 'true' }))).toBe('sales@example.com')
  })

  it('rejects an unverified email', () => {
    expect(parseIdTokenEmail(idToken({ email: 'sales@example.com', email_verified: false }))).toBeNull()
    expect(parseIdTokenEmail(idToken({ email: 'sales@example.com' }))).toBeNull()
  })

  it('rejects a token without a payload segment or with a non-JSON payload', () => {
    expect(parseIdTokenEmail('')).toBeNull()
    expect(parseIdTokenEmail('header')).toBeNull()
    expect(parseIdTokenEmail('header.!!!.sig')).toBeNull()
  })
})
