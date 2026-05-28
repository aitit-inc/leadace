/**
 * MCP OAuth 2.1 Authorization Server for LeadAce.
 *
 * Token model: the frontend's Supabase session is used only at
 * /authorize/finalize to verify the user's identity (extract `sub`).
 * From there on we mint our own HS256 JWT access tokens (signed with
 * SUPABASE_JWT_SECRET so the existing verifySupabaseJwt path still
 * validates them) and opaque refresh tokens stored in KV. This keeps
 * MCP sessions independent of the browser's Supabase session, so
 * refresh-token rotation in one client cannot invalidate the other.
 *
 * Refresh tokens are rotated on every successful refresh per OAuth 2.1
 * §6.1 (public clients with PKCE). The previous token is moved to a
 * short-lived tombstone — if it is presented again (= reuse, the OAuth
 * 2.1 leak signal), the entire token family is revoked and the client
 * is forced to re-authorize. Each authorization-code grant creates a
 * new family; rotations stay within the same family.
 */

import { SignJWT } from 'jose'
import { z } from 'zod'
import { verifyJwt } from '../auth/verify-jwt'

// Audience claim stamped on MCP-minted access tokens. Used by callers
// that must distinguish Supabase-issued tokens from MCP-issued tokens
// (e.g. /authorize/finalize, /sessions*). Supabase tokens carry
// `aud: 'authenticated'`; ours carry `aud: 'mcp'`.
export const MCP_ACCESS_TOKEN_AUDIENCE = 'mcp'

interface AuthSession {
  clientId: string
  codeChallenge: string
  redirectUri: string
  state: string
  expiresAt: number
}

interface AuthCode {
  clientId: string
  codeChallenge: string
  redirectUri: string
  userId: string
  expiresAt: number
}

interface McpRefresh {
  userId: string
  // Optional only for backward-compat with refresh tokens minted before
  // family tracking landed; new tokens always carry one. Tokens without a
  // familyId get a fresh family on first refresh (one-shot migration; the
  // 30-day TTL ages the legacy entries out).
  familyId?: string
  expiresAt: number
}

// Tombstone for a rotated refresh token. Lookup hit = reuse attempt
// (legitimate clients discard the old token after a successful refresh).
interface McpRefreshTombstone {
  familyId: string
}

// Per-family metadata for revocation + the Settings page session list.
// One family is created per /authorize → /token exchange and persists
// across rotations within that session.
interface McpFamily {
  ownerUserId: string
  clientId: string
  clientName: string | null
  createdAt: number
  lastSeenAt: number
  // Set when the family is revoked (via /revoke, reuse-detection, or the
  // Settings page). Once set, every token in the family is rejected on
  // next refresh.
  revokedAt?: number
  revokedReason?: 'reuse' | 'revoke_endpoint' | 'user_revoke'
}

// Per-user index of family IDs, for the Settings page session list. KV
// doesn't support efficient list-by-user, so we maintain this manually.
interface McpUserFamilies {
  familyIds: string[]
}

interface RegisteredClient {
  client_id: string
  redirect_uris: string[]
  client_name?: string
  grant_types: string[]
  response_types: string[]
  token_endpoint_auth_method: string
}

const AUTH_CODE_TTL_SECONDS = 600
const AUTH_SESSION_TTL_SECONDS = 600
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 30
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30
// Tombstones must outlive any live refresh token in the family — otherwise
// reuse of an old token past the tombstone window reads as plain unknown
// and silently misses the family-revoke step OAuth 2.1 §6.1 requires. We
// align with REFRESH_TOKEN_TTL_SECONDS so reuse is detectable for the full
// lifetime of any sibling token.
const REFRESH_TOMBSTONE_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS
const FAMILY_TTL_SECONDS = 60 * 60 * 24 * 30
const USER_FAMILY_INDEX_TTL_SECONDS = 60 * 60 * 24 * 30
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60

function kvJson<T>(prefix: string, ttlSeconds: number) {
  const k = (id: string) => `${prefix}:${id}`
  return {
    get: (kv: KVNamespace, id: string) => kv.get<T>(k(id), 'json'),
    put: (kv: KVNamespace, id: string, value: T) =>
      kv.put(k(id), JSON.stringify(value), { expirationTtl: ttlSeconds }),
    del: (kv: KVNamespace, id: string) => kv.delete(k(id)),
  }
}

const authCodes = kvJson<AuthCode>('code', AUTH_CODE_TTL_SECONDS)
const authSessions = kvJson<AuthSession>('session', AUTH_SESSION_TTL_SECONDS)
const registeredClients = kvJson<RegisteredClient>('client', CLIENT_TTL_SECONDS)
const mcpRefreshes = kvJson<McpRefresh>('mcprefresh', REFRESH_TOKEN_TTL_SECONDS)
const mcpRefreshTombs = kvJson<McpRefreshTombstone>('mcprefreshtomb', REFRESH_TOMBSTONE_TTL_SECONDS)
const mcpFamilies = kvJson<McpFamily>('mcpfamily', FAMILY_TTL_SECONDS)
const mcpUserFamilies = kvJson<McpUserFamilies>('mcpuserfam', USER_FAMILY_INDEX_TTL_SECONDS)

function oauthError(code: string, status: number, description?: string): Response {
  return Response.json(
    description ? { error: code, error_description: description } : { error: code },
    { status },
  )
}

function generateId(): string {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

async function verifyPkce(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const data = new TextEncoder().encode(codeVerifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const computed = base64UrlEncode(new Uint8Array(hashBuffer))
  return computed === codeChallenge
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = ''
  for (const byte of buffer) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function handleMetadata(baseUrl: string): Response {
  return Response.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    revocation_endpoint: `${baseUrl}/revoke`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // PKCE only — there is no shared client secret in this server.
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: ['read', 'write'],
  })
}

export function handleResourceMetadata(baseUrl: string): Response {
  return Response.json({
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    scopes_supported: ['read', 'write'],
  })
}

// https: always; http: only for loopback (RFC 8252 / OAuth 2.1 §8.4.2).
// Rejecting javascript: / data: / file: blocks a same-origin
// script-execution sink (the frontend assigns the returned redirect to
// window.location.href). Restricting non-loopback to https: prevents
// authorization codes from being delivered over plaintext to public
// hosts — the code itself is single-use + PKCE-bound, but the
// state-channel exposure is needless. Claude Code's loopback handler
// (http://127.0.0.1:<port>/callback) is preserved.
function isAllowedRedirectUri(uri: string): boolean {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return false
  }
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1'
  }
  return false
}

// RFC 7591 §2: unknown fields are silently dropped (loose schema, not
// `.strict()`); fields we DO consume are validated against the values
// advertised in /.well-known/oauth-authorization-server, so bad metadata
// fails at registration (invalid_client_metadata, RFC 7591 §3.2.2)
// rather than later at /token with unsupported_grant_type.
const registerBodySchema = z.object({
  redirect_uris: z.array(z.string()).min(1),
  client_name: z.string().min(1).max(255).optional(),
  grant_types: z.array(z.enum(['authorization_code', 'refresh_token'])).optional(),
  response_types: z.array(z.literal('code')).optional(),
  token_endpoint_auth_method: z.literal('none').optional(),
})

export async function handleRegister(request: Request, kv: KVNamespace): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return oauthError('invalid_request', 400)
  }

  const parsed = registerBodySchema.safeParse(raw)
  if (!parsed.success) {
    // redirect_uris failure surfaces as invalid_redirect_uri (RFC 7591 §3.2.2);
    // everything else uses the generic invalid_client_metadata.
    const onRedirectUris = parsed.error.issues.some((i) => i.path[0] === 'redirect_uris')
    return oauthError(
      onRedirectUris ? 'invalid_redirect_uri' : 'invalid_client_metadata',
      400,
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  }
  const body = parsed.data

  const redirectUris: string[] = []
  for (const uri of body.redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      return oauthError(
        'invalid_redirect_uri',
        400,
        'Each redirect_uri must be https:// (or http:// for loopback only)',
      )
    }
    redirectUris.push(uri)
  }

  const clientId = generateId()
  const client: RegisteredClient = {
    client_id: clientId,
    redirect_uris: redirectUris,
    client_name: body.client_name,
    grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: body.response_types ?? ['code'],
    token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
  }

  await registeredClients.put(kv, clientId, client)

  return Response.json({
    ...client,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, { status: 201 })
}

function htmlError(message: string, status: number): Response {
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>LeadAce — Authorization error</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F4F2F0;color:#333}p{max-width:420px;padding:24px;font-size:14px;line-height:1.5}</style>
</head><body><p>${safe}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  )
}

export async function handleAuthorizeGet(
  request: Request,
  kv: KVNamespace,
  frontendUrl: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams

  const clientId = params.get('client_id')
  const codeChallenge = params.get('code_challenge')
  const redirectUri = params.get('redirect_uri')
  const codeChallengeMethod = params.get('code_challenge_method')

  if (!clientId || !codeChallenge || !redirectUri) {
    return htmlError('Missing client_id, code_challenge, or redirect_uri. Run /setup again.', 400)
  }
  if (codeChallengeMethod && codeChallengeMethod !== 'S256') {
    return htmlError('Only S256 code_challenge_method is supported.', 400)
  }
  // OAuth 2.0 §4.1.1 doesn't cap `state`, but we store it in KV verbatim and
  // echo it back on /token. 2 KiB is well above what any sane client needs
  // (it's an opaque CSRF nonce, not a payload) and keeps KV writes bounded.
  const stateParam = params.get('state') ?? ''
  if (stateParam.length > 2048) {
    return htmlError('state parameter exceeds the 2 KB limit.', 400)
  }

  // redirect_uri must match a registered value exactly. Without this, the
  // consent page would bind to attacker-controlled values and the eventual
  // 303 from handleAuthorizeFinalize would deliver the authorization code
  // to that endpoint — yielding account takeover via the HS256-minted
  // access token the main API auth path accepts (verify-jwt.ts HS256
  // fallback).
  const registered = await registeredClients.get(kv, clientId)
  if (!registered) {
    return htmlError('Unknown client_id. Register the client before authorizing.', 400)
  }
  if (!registered.redirect_uris.includes(redirectUri)) {
    return htmlError('redirect_uri is not registered for this client.', 400)
  }
  // Defense-in-depth against clients that were registered before the
  // current scheme rules landed (KV entries live up to
  // CLIENT_TTL_SECONDS = 30 days). Without this, a stored javascript: /
  // data: URI from the unvalidated era — or a non-loopback http: URI
  // from before the tightening — would still pass the allowlist and
  // eventually be delivered to window.location.href on the consent page.
  if (!isAllowedRedirectUri(redirectUri)) {
    return htmlError('redirect_uri scheme is not allowed.', 400)
  }

  const sessionId = generateId()
  await authSessions.put(kv, sessionId, {
    clientId,
    codeChallenge,
    redirectUri,
    state: stateParam,
    expiresAt: Date.now() + AUTH_SESSION_TTL_SECONDS * 1000,
  })

  const consentUrl = new URL('/mcp-authorize', frontendUrl)
  consentUrl.searchParams.set('session', sessionId)
  return Response.redirect(consentUrl.toString(), 302)
}

export async function handleAuthorizeSessionInfo(
  request: Request,
  kv: KVNamespace,
): Promise<Response> {
  const sessionId = new URL(request.url).searchParams.get('session')
  if (!sessionId) {
    return oauthError('invalid_request', 400)
  }
  const session = await authSessions.get(kv, sessionId)
  if (!session || session.expiresAt < Date.now()) {
    return oauthError('invalid_session', 404)
  }

  const registered = await registeredClients.get(kv, session.clientId)

  return Response.json({
    clientId: session.clientId,
    clientName: registered?.client_name ?? null,
    redirectUri: session.redirectUri,
    state: session.state,
  })
}

export async function handleAuthorizeFinalize(
  request: Request,
  kv: KVNamespace,
  jwtSecret: string,
  supabaseUrl: string,
): Promise<Response> {
  let body: { session?: string; access_token?: string }
  try {
    body = await request.json() as { session?: string; access_token?: string }
  } catch {
    return oauthError('invalid_request', 400)
  }

  const { session: sessionId, access_token: accessToken } = body
  if (!sessionId || !accessToken) {
    return oauthError('invalid_request', 400, 'session and access_token are required')
  }

  const [verified, session] = await Promise.all([
    verifyJwt(accessToken, jwtSecret, supabaseUrl),
    authSessions.get(kv, sessionId),
  ])
  // Refuse MCP-minted access tokens here: this endpoint is the
  // Supabase-session → authorization-code bridge. Allowing an existing
  // MCP token to mint a new code would let a leaked MCP token bootstrap
  // a fresh authorization without re-proving the user's Supabase
  // identity.
  if (!verified || verified.aud === MCP_ACCESS_TOKEN_AUDIENCE) {
    return oauthError('invalid_token', 401, 'Supabase access_token failed verification')
  }
  const userId = verified.sub
  if (!session || session.expiresAt < Date.now()) {
    return oauthError('invalid_session', 404, 'Authorization session expired or unknown')
  }

  const code = generateId()
  await authCodes.put(kv, code, {
    clientId: session.clientId,
    codeChallenge: session.codeChallenge,
    redirectUri: session.redirectUri,
    userId,
    expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
  })

  await authSessions.del(kv, sessionId)

  const redirectUrl = new URL(session.redirectUri)
  redirectUrl.searchParams.set('code', code)
  if (session.state) redirectUrl.searchParams.set('state', session.state)

  return Response.json({ redirect: redirectUrl.toString() })
}

export async function handleToken(
  request: Request,
  kv: KVNamespace,
  jwtSecret: string,
): Promise<Response> {
  let body: Record<string, string>
  try {
    const ct = request.headers.get('Content-Type') ?? ''
    if (ct.includes('application/json')) {
      body = await request.json() as Record<string, string>
    } else {
      const fd = await request.formData()
      body = Object.fromEntries(fd.entries()) as Record<string, string>
    }
  } catch {
    return oauthError('invalid_request', 400)
  }

  const grantType = body['grant_type']

  if (grantType === 'authorization_code') {
    return handleAuthCodeGrant(body, kv, jwtSecret)
  }
  if (grantType === 'refresh_token') {
    return handleRefreshGrant(body, kv, jwtSecret)
  }

  return oauthError('unsupported_grant_type', 400)
}

async function handleAuthCodeGrant(
  body: Record<string, string>,
  kv: KVNamespace,
  jwtSecret: string,
): Promise<Response> {
  const { code, code_verifier, redirect_uri } = body

  if (!code || !code_verifier) {
    return oauthError('invalid_request', 400, 'code and code_verifier required')
  }

  const stored = await authCodes.get(kv, code)
  if (!stored || stored.expiresAt < Date.now()) {
    console.log('[oauth.code] invalid/expired code', { hasStored: !!stored, expired: stored ? stored.expiresAt < Date.now() : null })
    return oauthError('invalid_grant', 400, 'Invalid or expired authorization code')
  }

  // Defensive: reject codes without userId rather than minting sub=undefined.
  if (!stored.userId) {
    console.log('[oauth.code] missing userId on stored code', { clientId: stored.clientId })
    return oauthError('invalid_grant', 400, 'Authorization code is no longer valid; please re-authorize')
  }

  // RFC 6749 §4.1.3: when redirect_uri was included in the authorization
  // request (we always require it at /authorize, so always here), the client
  // MUST resend the same value at /token and the values MUST match. PKCE
  // already binds the code to the verifier, so the practical leak surface
  // is small — but keeping the spec invariant closes the gap and stops
  // looking like a foot-gun in audits.
  if (!redirect_uri || redirect_uri !== stored.redirectUri) {
    return oauthError('invalid_grant', 400, 'redirect_uri mismatch or missing')
  }

  const pkceValid = await verifyPkce(code_verifier, stored.codeChallenge)
  if (!pkceValid) {
    return oauthError('invalid_grant', 400, 'PKCE verification failed')
  }

  await authCodes.del(kv, code)

  const accessToken = await mintAccessJwt(stored.userId, jwtSecret)
  const refreshToken = generateId()
  const familyId = generateId()
  const now = Date.now()

  const client = await registeredClients.get(kv, stored.clientId)

  await Promise.all([
    mcpRefreshes.put(kv, refreshToken, {
      userId: stored.userId,
      familyId,
      expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
    }),
    mcpFamilies.put(kv, familyId, {
      ownerUserId: stored.userId,
      clientId: stored.clientId,
      clientName: client?.client_name ?? null,
      createdAt: now,
      lastSeenAt: now,
    }),
  ])
  await touchUserFamily(kv, stored.userId, familyId)

  const refreshFp = await fingerprint(refreshToken)
  console.log('[oauth.code] exchanged', { userId: stored.userId, refreshFp, clientId: stored.clientId, familyId })

  return Response.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  })
}

// KV has no list-by-user query, so we maintain this index explicitly.
// Always re-put (even when the list is unchanged) so the index TTL is
// refreshed on every rotation, matching the refresh-token and family TTL
// extensions — otherwise a >30-day active session ages its index entry
// out and disappears from Settings while the family stays live.
async function touchUserFamily(kv: KVNamespace, userId: string, familyId: string): Promise<void> {
  const existing = await mcpUserFamilies.get(kv, userId)
  const familyIds = existing?.familyIds ?? []
  if (!familyIds.includes(familyId)) familyIds.push(familyId)
  await mcpUserFamilies.put(kv, userId, { familyIds })
}

async function revokeFamily(
  kv: KVNamespace,
  familyId: string,
  reason: NonNullable<McpFamily['revokedReason']>,
): Promise<void> {
  const family = await mcpFamilies.get(kv, familyId)
  if (!family) return
  if (family.revokedAt) return
  await mcpFamilies.put(kv, familyId, {
    ...family,
    revokedAt: Date.now(),
    revokedReason: reason,
  })
  console.log('[oauth.family] revoked', { familyId, reason, ownerUserId: family.ownerUserId })
}

async function handleRefreshGrant(
  body: Record<string, string>,
  kv: KVNamespace,
  jwtSecret: string,
): Promise<Response> {
  const refreshToken = body['refresh_token']
  if (!refreshToken) {
    console.log('[oauth.refresh] missing refresh_token in body')
    return oauthError('invalid_request', 400, 'refresh_token required')
  }

  const inFp = await fingerprint(refreshToken)

  // OAuth 2.1 reuse detection: a presented refresh token that's already
  // been rotated lives in the tombstone namespace. A legitimate client
  // discards the old token after a successful refresh, so reuse signals
  // either a leak or a non-conforming client. Either way the rule is:
  // revoke the entire family. Clients hitting this must restart from
  // /authorize.
  const tomb = await mcpRefreshTombs.get(kv, refreshToken)
  if (tomb) {
    await revokeFamily(kv, tomb.familyId, 'reuse')
    console.log('[oauth.refresh] reuse detected', { inFp, familyId: tomb.familyId })
    return oauthError('invalid_grant', 400, 'Refresh token reuse detected — session revoked')
  }

  const stored = await mcpRefreshes.get(kv, refreshToken)
  if (!stored) {
    console.log('[oauth.refresh] unknown refresh_token', { inFp })
    return oauthError('invalid_grant', 400, 'Refresh failed')
  }

  // Backward compat: tokens minted before family tracking landed have no
  // familyId. Assign a fresh family on first refresh so the rotation
  // path treats them uniformly going forward. They lose retroactive
  // reuse detection for that one-shot transition; the 30-day TTL retires
  // all legacy tokens within the migration window.
  let familyId = stored.familyId
  if (!familyId) {
    familyId = generateId()
    await mcpFamilies.put(kv, familyId, {
      ownerUserId: stored.userId,
      clientId: 'legacy',
      clientName: null,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    })
    await touchUserFamily(kv, stored.userId, familyId)
    console.log('[oauth.refresh] legacy token migrated', { inFp, userId: stored.userId, familyId })
  }

  const family = await mcpFamilies.get(kv, familyId)
  if (family?.revokedAt) {
    await mcpRefreshes.del(kv, refreshToken)
    console.log('[oauth.refresh] family revoked', { inFp, familyId, reason: family.revokedReason })
    return oauthError('invalid_grant', 400, 'Refresh token family revoked')
  }

  // Rotate: mint new → live FIRST, then tombstone old + delete old in
  // parallel. Per OAuth 2.1 §6.1 (and mitigates RFC 6819 §5.2.2.3 leak
  // scenarios) — public clients MUST get a fresh refresh token on every
  // exchange. Ordering matters: KV writes are non-transactional and
  // can fail independently. If we wrote the tombstone before the new
  // token, a transient failure on the new-token put would 5xx the
  // client, which then retries with the old token — only to hit the
  // tombstone and trigger a reuse-detection family-revoke. By writing
  // the new token first, a partial failure leaves the old token live
  // and replayable.
  const newRefresh = generateId()
  const now = Date.now()

  await mcpRefreshes.put(kv, newRefresh, {
    userId: stored.userId,
    familyId,
    expiresAt: now + REFRESH_TOKEN_TTL_SECONDS * 1000,
  })
  await Promise.all([
    mcpRefreshTombs.put(kv, refreshToken, { familyId }),
    mcpRefreshes.del(kv, refreshToken),
    family
      ? mcpFamilies.put(kv, familyId, { ...family, lastSeenAt: now })
      : Promise.resolve(),
    touchUserFamily(kv, stored.userId, familyId),
  ])

  const accessToken = await mintAccessJwt(stored.userId, jwtSecret)
  const newFp = await fingerprint(newRefresh)
  console.log('[oauth.refresh] rotated', { inFp, newFp, userId: stored.userId, familyId })

  return Response.json({
    access_token: accessToken,
    refresh_token: newRefresh,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
  })
}

// RFC 7009 token revocation. Public clients call this on sign-out so the
// refresh token can no longer be used; the response is 200 either way so
// the server doesn't leak whether the token existed.
export async function handleRevoke(request: Request, kv: KVNamespace): Promise<Response> {
  let body: Record<string, string>
  try {
    const ct = request.headers.get('Content-Type') ?? ''
    if (ct.includes('application/json')) {
      body = await request.json() as Record<string, string>
    } else {
      const fd = await request.formData()
      body = Object.fromEntries(fd.entries()) as Record<string, string>
    }
  } catch {
    // RFC 7009 §2.1 says invalid_request only when the request itself is
    // malformed beyond parsing. Otherwise 200 with no body.
    return oauthError('invalid_request', 400)
  }

  const token = body['token']
  if (!token) return oauthError('invalid_request', 400, 'token is required')

  // Access tokens are stateless HS256 JWTs with a short TTL; we can't
  // truly revoke them, only their refresh-token siblings. Per RFC 7009
  // §2.2 we still answer 200 to avoid token-existence leak.
  const stored = await mcpRefreshes.get(kv, token)
  if (stored) {
    const familyId = stored.familyId
    if (familyId) await revokeFamily(kv, familyId, 'revoke_endpoint')
    await mcpRefreshes.del(kv, token)
  } else {
    const tomb = await mcpRefreshTombs.get(kv, token)
    if (tomb) await revokeFamily(kv, tomb.familyId, 'revoke_endpoint')
  }

  return new Response(null, { status: 200 })
}

export interface McpSessionView {
  familyId: string
  clientId: string
  clientName: string | null
  createdAt: number
  lastSeenAt: number
}

export async function handleListSessions(
  userId: string,
  kv: KVNamespace,
): Promise<Response> {
  const index = await mcpUserFamilies.get(kv, userId)
  const familyIds = index?.familyIds ?? []
  if (familyIds.length === 0) {
    return Response.json({ sessions: [] })
  }

  const families = await Promise.all(
    familyIds.map(async (id) => {
      const f = await mcpFamilies.get(kv, id)
      return { id, family: f }
    }),
  )

  const live: McpSessionView[] = []
  const liveIds: string[] = []
  for (const { id, family } of families) {
    if (!family) continue
    if (family.revokedAt) continue
    if (family.ownerUserId !== userId) continue
    live.push({
      familyId: id,
      clientId: family.clientId,
      clientName: family.clientName,
      createdAt: family.createdAt,
      lastSeenAt: family.lastSeenAt,
    })
    liveIds.push(id)
  }

  if (liveIds.length !== familyIds.length) {
    await mcpUserFamilies.put(kv, userId, { familyIds: liveIds })
  }

  return Response.json({ sessions: live })
}

export async function handleRevokeSession(
  userId: string,
  familyId: string,
  kv: KVNamespace,
): Promise<Response> {
  const family = await mcpFamilies.get(kv, familyId)
  if (!family) {
    return Response.json({ error: 'not_found' }, { status: 404 })
  }
  // Strict ownership check — KV is shared across users; the family id is
  // path-supplied. Without this any signed-in user could revoke any
  // session by guessing or leaking a family id.
  if (family.ownerUserId !== userId) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  await revokeFamily(kv, familyId, 'user_revoke')
  return new Response(null, { status: 204 })
}

// HS256-signed with SUPABASE_JWT_SECRET so the existing verifyJwt /
// verifySupabaseJwt path validates these via the HS256 fallback. The
// `aud: 'mcp'` claim lets surfaces that should refuse MCP-issued tokens
// (/authorize/finalize, /sessions*) reject them.
async function mintAccessJwt(userId: string, jwtSecret: string): Promise<string> {
  const secret = new TextEncoder().encode(jwtSecret)
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_SECONDS)
    .setAudience(MCP_ACCESS_TOKEN_AUDIENCE)
    .sign(secret)
}

/** Short hash of a token for log correlation without leaking the secret. */
export async function fingerprint(token: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return Array.from(new Uint8Array(buf).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}
