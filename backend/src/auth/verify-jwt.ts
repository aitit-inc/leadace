import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose'

export interface VerifiedJwt {
  sub: string
  /**
   * Audience claim. MCP-minted access tokens stamp this as `'mcp'`
   * (see `mintAccessJwt` in mcp/oauth.ts). Supabase-issued tokens leave
   * it as `'authenticated'` or undefined. Callers that need to refuse
   * MCP-minted tokens (e.g. `/authorize/finalize`, the Settings-only
   * `/sessions` surface) must inspect this field.
   */
  aud: string | undefined
}

function decode(payload: JWTPayload): VerifiedJwt | null {
  const sub = payload['sub']
  if (typeof sub !== 'string') return null
  const audRaw = payload['aud']
  const aud = typeof audRaw === 'string' ? audRaw : undefined
  return { sub, aud }
}

/**
 * Verify a JWT minted by Supabase or by the MCP worker (both signed with
 * SUPABASE_JWT_SECRET on the HS256 fallback path).
 *
 * Tries ES256 via JWKS first (new Supabase CLI), falls back to HS256.
 * Returns the verified payload subset or null on failure.
 */
export async function verifyJwt(
  token: string,
  jwtSecret: string,
  supabaseUrl?: string,
): Promise<VerifiedJwt | null> {
  if (supabaseUrl) {
    try {
      const jwksUrl = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl)
      const JWKS = createRemoteJWKSet(jwksUrl)
      const { payload } = await jwtVerify(token, JWKS)
      return decode(payload)
    } catch {
      // JWKS attempt failed; fall through to HS256 below.
    }
  }

  try {
    const secret = new TextEncoder().encode(jwtSecret)
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] })
    return decode(payload)
  } catch {
    return null
  }
}

/**
 * Verify a JWT and return only the `sub` claim. Convenience wrapper for
 * the common case where the caller doesn't care which authority issued
 * the token. Surfaces that DO care (Supabase-issued only) must use
 * `verifyJwt` and check `aud` themselves.
 */
export async function verifySupabaseJwt(
  token: string,
  jwtSecret: string,
  supabaseUrl?: string,
): Promise<string | null> {
  const v = await verifyJwt(token, jwtSecret, supabaseUrl)
  return v?.sub ?? null
}
