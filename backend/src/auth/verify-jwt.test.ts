import { describe, it, expect } from 'vitest'
import { SignJWT } from 'jose'
import { verifyJwt } from './verify-jwt'

// Offline HS256 path only — the ES256 JWKS branch fetches over the network and
// is exercised by integration, not here. Calls omit supabaseUrl so verifyJwt
// goes straight to the HS256 fallback.
const SECRET = 'super-secret-jwt-key'
const key = new TextEncoder().encode(SECRET)

const mint = (claims: { sub?: string; aud?: string; email?: string; scope?: string; expSeconds?: number }) => {
  let t = new SignJWT({ email: claims.email, scope: claims.scope }).setProtectedHeader({ alg: 'HS256' })
  if (claims.sub !== undefined) t = t.setSubject(claims.sub)
  if (claims.aud !== undefined) t = t.setAudience(claims.aud)
  if (claims.expSeconds !== undefined) t = t.setExpirationTime(claims.expSeconds)
  return t.sign(key)
}

describe('verifyJwt (HS256 fallback)', () => {
  it('returns sub, aud and email for a valid token', async () => {
    const token = await mint({ sub: 'user-1', aud: 'authenticated', email: 'a@example.com', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: 'authenticated', email: 'a@example.com', readOnly: false })
  })

  it('preserves an mcp audience so callers can refuse it', async () => {
    const token = await mint({ sub: 'user-1', aud: 'mcp', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: 'mcp', email: null, readOnly: false })
  })

  it('reads a read-only grant from the scope of an mcp token only', async () => {
    const expSeconds = Math.floor(Date.now() / 1000) + 3600
    const readOnly = async (aud: string | undefined, scope: string) =>
      (await verifyJwt(await mint({ sub: 'user-1', aud, scope, expSeconds }), SECRET))?.readOnly
    expect(await readOnly('mcp', 'read')).toBe(true)
    expect(await readOnly('mcp', 'read write')).toBe(false)
    // A scope claim on a browser session token is not ours and changes nothing.
    expect(await readOnly('authenticated', 'read')).toBe(false)
    expect(await readOnly(undefined, 'read')).toBe(false)
  })

  it('returns undefined aud and null email when the claims are absent', async () => {
    const token = await mint({ sub: 'user-1', expSeconds: Math.floor(Date.now() / 1000) + 3600 })
    expect(await verifyJwt(token, SECRET)).toEqual({ sub: 'user-1', aud: undefined, email: null, readOnly: false })
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
