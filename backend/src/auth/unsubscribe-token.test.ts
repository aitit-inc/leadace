import { describe, it, expect } from 'vitest'
import type { TenantId } from '../domain/ids'
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
  InvalidUnsubscribeTokenError,
} from './unsubscribe-token'

const SECRET = 'test-secret'
const tenant = 'tenant_abc123' as TenantId

describe('unsubscribe token sign/verify', () => {
  it('round-trips a payload', async () => {
    const token = await signUnsubscribeToken({ prospectId: 42, tenantId: tenant }, SECRET)
    expect(await verifyUnsubscribeToken(token, SECRET)).toEqual({ prospectId: 42, tenantId: tenant })
  })

  it('rejects a token signed with a different secret', async () => {
    const token = await signUnsubscribeToken({ prospectId: 42, tenantId: tenant }, SECRET)
    await expect(verifyUnsubscribeToken(token, 'other-secret')).rejects.toThrow(InvalidUnsubscribeTokenError)
  })

  it('rejects a forged prospectId/tenantId (signature no longer matches)', async () => {
    const token = await signUnsubscribeToken({ prospectId: 42, tenantId: tenant }, SECRET)
    const [, , sig] = token.split('.')
    await expect(verifyUnsubscribeToken(`99.${tenant}.${sig}`, SECRET)).rejects.toThrow(InvalidUnsubscribeTokenError)
  })

  it('rejects malformed tokens and non-positive prospect ids', async () => {
    await expect(verifyUnsubscribeToken('not-a-token', SECRET)).rejects.toThrow(InvalidUnsubscribeTokenError)
    await expect(verifyUnsubscribeToken('a.b', SECRET)).rejects.toThrow(InvalidUnsubscribeTokenError)
    const token = await signUnsubscribeToken({ prospectId: 1, tenantId: tenant }, SECRET)
    const [, , sig] = token.split('.')
    await expect(verifyUnsubscribeToken(`0.${tenant}.${sig}`, SECRET)).rejects.toThrow(InvalidUnsubscribeTokenError)
  })
})
