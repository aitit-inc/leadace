import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { verifyJwt } from './verify-jwt'

// Offline HS256 path only — the ES256 JWKS branch fetches over the network and
// is exercised by integration, not here. Calls omit supabaseUrl so verifyJwt
// goes straight to the HS256 fallback.
const SECRET = 'super-secret-jwt-key'
const key = new TextEncoder().encode(SECRET)

const mint = (claims: { sub?: string; aud?: string; expSeconds?: number }) => {
  let t = new SignJWT({}).setProtectedHeader({ alg: 'HS256' })
  if (claims.sub !== undefined) t = t.setSubject(claims.sub)
  if (claims.aud !== undefined) t = t.setAudience(claims.aud)
  if (claims.expSeconds !== undefined) t = t.setExpirationTime(claims.expSeconds)
  return t.sign(key)
}

describe('verifyJwt (HS256 fallback)', () => {
  it('returns sub and aud for a valid token', async () => {
    const token = await mint({ sub: 'user-1', aud: 'authenticated', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: 'authenticated' })
  })

  it('preserves an mcp audience so callers can refuse it', async () => {
    const token = await mint({ sub: 'user-1', aud: 'mcp', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: 'mcp' })
  })

  it('returns undefined aud when the claim is absent', async () => {
    const token = await mint({ sub: 'user-1', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: undefined })
  })

  it('returns null on a wrong-secret signature', async () => {
    const token = await mint({ sub: 'user-1', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, 'wrong-secret')).toBeNull()
  })

  it('returns null on an expired token', async () => {
    const token = await mint({ sub: 'user-1', expSeconds: Math.floor(Date.now() / 1000) - 60 })
    expect(await verifyJwt(token, SECRET)).toBeNull()
  })

  it('returns null on a malformed token string', async () => {
    expect(await verifyJwt('not.a.jwt', SECRET)).toBeNull()
  })
})
