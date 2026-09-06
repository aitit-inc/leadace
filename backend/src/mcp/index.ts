import * as Sentry from '@sentry/cloudflare'
import { sentryOptions } from '../sentry'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { verifyJwt, verifySupabaseJwt } from '../auth/verify-jwt'
import { SERVER_VERSION } from './version'
import { buildToolRegistry, type ToolCtx, type ToolDef } from '../tools/registry'
import {
  handleMetadata,
  handleResourceMetadata,
  handleRegister,
  handleAuthorizeGet,
  handleAuthorizeSessionInfo,
  handleAuthorizeFinalize,
  handleToken,
  handleRevoke,
  handleListSessions,
  handleRevokeSession,
  fingerprint,
  MCP_ACCESS_TOKEN_AUDIENCE,
} from './oauth'

type Env = {
  WEB_API_URL: string
  SUPABASE_JWT_SECRET: string
  SUPABASE_URL: string
  SUPABASE_ANON_KEY: string
  ENVIRONMENT: string
  FRONTEND_URL: string
  MCP_OAUTH_STORE: KVNamespace
  // Cloud-only error tracking. Worker secret on the hosted deploy; unset for
  // local dev / self-host, where Sentry is a no-op.
  SENTRY_DSN?: string
}

async function extractUserId(request: Request, jwtSecret: string, supabaseUrl?: string): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  return verifySupabaseJwt(token, jwtSecret, supabaseUrl)
}

// Variant that refuses MCP-minted access tokens. Used by Settings-facing
// surfaces (/sessions*) so an authorized MCP client cannot enumerate or
// revoke the user's other MCP sessions on their behalf — that management
// surface is intended for the browser session only.
async function extractSupabaseUserId(request: Request, jwtSecret: string, supabaseUrl?: string): Promise<string | null> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  const token = authHeader.slice(7)
  const verified = await verifyJwt(token, jwtSecret, supabaseUrl)
  if (!verified) return null
  if (verified.aud === MCP_ACCESS_TOKEN_AUDIENCE) return null
  return verified.sub
}

async function callApi(
  method: string,
  path: string,
  body: unknown,
  apiUrl: string,
  authHeader: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${apiUrl}/api${path}`
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authHeader,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })

  const data = await res.json()
  return { ok: res.ok, status: res.status, data }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id',
}

function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers)
  for (const [k, v] of Object.entries(corsHeaders)) {
    newHeaders.set(k, v)
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  })
}

// Lazy so requests that never touch the catalog (OAuth flow, /.well-known/*)
// don't pay the build cost on a cold isolate.
let toolRegistry: ToolDef[] | null = null

function createMcpServer(ctx: ToolCtx): McpServer {
  toolRegistry ??= buildToolRegistry()
  const server = new McpServer({ name: 'lead-ace', version: SERVER_VERSION })
  for (const tool of toolRegistry) {
    server.tool(tool.name, tool.description, tool.schema, (args) => tool.handler(args, ctx))
  }
  return server
}

const mcpHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      console.error('Unhandled error:', e)
      // No-op when SENTRY_DSN is unset (self-host / local). The full exception
      // (incl. message) goes to Sentry, so the response stays opaque — no
      // internal detail to unauthenticated callers (matches the API worker).
      Sentry.captureException(e)
      return withCors(Response.json(
        { error: 'Internal server error' },
        { status: 500 },
      ))
    }
  },
}

export default Sentry.withSentry(
  (env: Env) => sentryOptions(env.SENTRY_DSN, env.ENVIRONMENT),
  mcpHandler,
)

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const baseUrl = url.origin

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (path === '/.well-known/oauth-authorization-server') {
    return withCors(handleMetadata(baseUrl))
  }

  if (path === '/.well-known/oauth-protected-resource') {
    return withCors(handleResourceMetadata(baseUrl))
  }

  if (path === '/register' && request.method === 'POST') {
    return withCors(await handleRegister(request, env.MCP_OAUTH_STORE))
  }

  if (path === '/authorize' && request.method === 'GET') {
    return await handleAuthorizeGet(request, env.MCP_OAUTH_STORE, env.FRONTEND_URL)
  }

  if (path === '/authorize/session' && request.method === 'GET') {
    return withCors(await handleAuthorizeSessionInfo(request, env.MCP_OAUTH_STORE))
  }

  if (path === '/authorize/finalize' && request.method === 'POST') {
    return withCors(
      await handleAuthorizeFinalize(request, env.MCP_OAUTH_STORE, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL),
    )
  }

  if (path === '/token' && request.method === 'POST') {
    return withCors(await handleToken(request, env.MCP_OAUTH_STORE, env.SUPABASE_JWT_SECRET))
  }

  // RFC 7009 token revocation. The presented token is the authentication —
  // no Bearer header required.
  if (path === '/revoke' && request.method === 'POST') {
    return withCors(await handleRevoke(request, env.MCP_OAUTH_STORE))
  }

  const authHeaderRaw = request.headers.get('Authorization')
  const userId = await extractUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
  if (!userId) {
    const hasBearer = authHeaderRaw?.startsWith('Bearer ') ?? false
    let accessFp: string | null = null
    let exp: number | null = null
    let nowGap: number | null = null
    if (hasBearer) {
      const token = authHeaderRaw!.slice(7)
      accessFp = await fingerprint(token)
      // Best-effort decode of exp claim without verification (verification already failed above).
      try {
        const parts = token.split('.')
        if (parts.length === 3 && parts[1]) {
          const payloadJson = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'))
          const claims = JSON.parse(payloadJson) as { exp?: number }
          if (typeof claims.exp === 'number') {
            exp = claims.exp
            nowGap = Math.floor(Date.now() / 1000) - claims.exp
          }
        }
      } catch {
        // best-effort diagnostics only
      }
    }
    console.log('[mcp.auth] 401', { path, method: request.method, hasBearer, accessFp, exp, nowGap })
    return withCors(new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      },
    }))
  }

  // Session-management endpoints are Supabase-session-only — extractSupabaseUserId
  // rejects MCP-minted tokens (aud=mcp) so an authorized MCP client cannot
  // revoke its siblings or enumerate other sessions for the user it acts
  // on behalf of.
  if (path === '/sessions' && request.method === 'GET') {
    const supabaseUserId = await extractSupabaseUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
    if (!supabaseUserId) {
      return withCors(Response.json({ error: 'forbidden' }, { status: 403 }))
    }
    return withCors(await handleListSessions(supabaseUserId, env.MCP_OAUTH_STORE))
  }
  const sessionRevokeMatch = path.match(/^\/sessions\/([^/]+)$/)
  if (sessionRevokeMatch && request.method === 'DELETE') {
    const supabaseUserId = await extractSupabaseUserId(request, env.SUPABASE_JWT_SECRET, env.SUPABASE_URL)
    if (!supabaseUserId) {
      return withCors(Response.json({ error: 'forbidden' }, { status: 403 }))
    }
    return withCors(await handleRevokeSession(supabaseUserId, sessionRevokeMatch[1]!, env.MCP_OAUTH_STORE))
  }

  // Stateless mode does not support SSE streams, and Workers cannot keep
  // long-lived connections — POST only.
  if (request.method !== 'POST') {
    return withCors(Response.json(
      { error: 'Method not allowed. Use POST for MCP requests.' },
      { status: 405 },
    ))
  }

  const authHeader = request.headers.get('Authorization') ?? ''
  const server = createMcpServer({
    callApi: (method, path, body) => callApi(method, path, body, env.WEB_API_URL, authHeader),
  })
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true, // Return JSON instead of SSE streams (Workers compat)
  })

  await server.connect(transport)
  return withCors(await transport.handleRequest(request))
}
