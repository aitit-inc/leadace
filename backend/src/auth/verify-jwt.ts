import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose'

export const MCP_AUDIENCE = 'mcp'

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

// jose caches keys per JWKS instance (10 min, 30 s cooldown); one instance
// per URL keeps that cache across requests instead of refetching per verify.
const jwksByUrl = new Map<string, ReturnType<typeof createRemoteJWKSet>>()
function jwksFor(supabaseUrl: string) {
  const url = new URL('/auth/v1/.well-known/jwks.json', supabaseUrl).href
  let set = jwksByUrl.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url))
    jwksByUrl.set(url, set)
  }
  return set
}

function decode(payload: JWTPayload): VerifiedJwt | null {
  const sub = payload['sub']
  if (typeof sub !== 'string') return null
  const audRaw = payload['aud']
  const aud = typeof audRaw === 'string' ? audRaw : undefined
  return { sub, aud }
}

/**
 * Accepts JWTs minted by Supabase or by the MCP worker (both signed with
 * SUPABASE_JWT_SECRET on the HS256 fallback path). Tries ES256 via JWKS
 * first (new Supabase CLI), falls back to HS256.
 */
export async function verifyJwt(
  token: string,
  jwtSecret: string,
  supabaseUrl?: string,
): Promise<VerifiedJwt | null> {
  if (supabaseUrl) {
    try {
      // Issuer intentionally unpinned: a custom auth domain makes `iss`
      // config-dependent, and a mismatch would reject every login.
      const { payload } = await jwtVerify(token, jwksFor(supabaseUrl), { algorithms: ['ES256'] })
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
 * Accepts tokens from either authority. Surfaces that must refuse
 * MCP-minted tokens use `verifyJwt` and check `aud` themselves.
 */
export async function verifySupabaseJwt(
  token: string,
  jwtSecret: string,
  supabaseUrl?: string,
): Promise<string | null> {
  const v = await verifyJwt(token, jwtSecret, supabaseUrl)
  return v?.sub ?? null
}
