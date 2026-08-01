import { describe, it, expect } from 'vitest'
import { deriveAlerts, type IdentityAlertInput } from './alerts'

const gmail = (over: Partial<IdentityAlertInput> = {}): IdentityAlertInput => ({
  fromEmail: 'a@example.com',
  provider: 'gmail_oauth',
  scope: 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.readonly',
  authRevokedAt: null,
  ...over,
})

describe('deriveAlerts', () => {
  it('is empty for a healthy gmail identity', () => {
    expect(deriveAlerts([gmail()])).toEqual([])
  })

  it('is empty for smtp_imap, which has no OAuth scope', () => {
    expect(deriveAlerts([gmail({ provider: 'smtp_imap', scope: null })])).toEqual([])
  })

  it('flags a gmail identity missing the readonly scope', () => {
    expect(deriveAlerts([gmail({ scope: 'https://www.googleapis.com/auth/gmail.send' })])).toEqual([
      { kind: 'reply_collection_scope_missing', fromEmail: 'a@example.com' },
    ])
  })

  it('compares whole tokens, so a scope the readonly URL only prefixes does not count', () => {
    const alerts = deriveAlerts([gmail({ scope: 'https://www.googleapis.com/auth/gmail.readonly.metadata' })])
    expect(alerts).toEqual([{ kind: 'reply_collection_scope_missing', fromEmail: 'a@example.com' }])
  })

  it('flags a revoked identity with the first detection time', () => {
    const at = new Date('2026-07-29T09:00:00.000Z')
    expect(deriveAlerts([gmail({ authRevokedAt: at })])).toEqual([
      { kind: 'reply_collection_revoked', fromEmail: 'a@example.com', since: at.toISOString() },
    ])
  })

  it('reports revoked only, when the scope is missing too', () => {
    const alerts = deriveAlerts([gmail({ scope: null, authRevokedAt: new Date('2026-07-29T09:00:00.000Z') })])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.kind).toBe('reply_collection_revoked')
  })

  it('reports one alert per affected identity', () => {
    const alerts = deriveAlerts([
      gmail(),
      gmail({ fromEmail: 'b@example.com', scope: null }),
      gmail({ fromEmail: 'c@example.com', authRevokedAt: new Date('2026-07-29T09:00:00.000Z') }),
    ])
    expect(alerts.map((a) => a.fromEmail)).toEqual(['b@example.com', 'c@example.com'])
  })
})
