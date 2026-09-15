import { createMiddleware } from 'hono/factory'
import { and, eq, isNull } from 'drizzle-orm'
import { MCP_AUDIENCE, verifyJwt } from '../../auth/verify-jwt'
import { createDb } from '../../db/connection'
import { tenantMembers, tenants } from '../../db/schema'
import { asTenantId } from '../../domain/ids'
import { logFunnel } from '../../services/funnel'
import type { Env, Variables } from '../types'
import { INTERNAL_DISPATCH_HEADER, INTERNAL_ORIGIN_HEADER, internalDispatchToken } from '../internal-dispatch'

function bearerToken(header: string | undefined): string | null {
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}

// A browser cannot put a header on a WebSocket, so the chat's live feed offers
// the token as a subprotocol, after `leadace`.
function socketToken(header: string | undefined): string | null {
  const [name, token] = (header ?? '').split(',').map((p) => p.trim())
  return name === 'leadace' && token ? token : null
}

export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const token = bearerToken(c.req.header('Authorization')) ?? socketToken(c.req.header('Sec-WebSocket-Protocol'))
    if (!token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const verified = await verifyJwt(token, c.env.SUPABASE_JWT_SECRET, c.env.SUPABASE_URL)

    if (!verified) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    const userId = verified.sub
    const isMcp = verified.aud === MCP_AUDIENCE
    const internal = c.req.header(INTERNAL_DISPATCH_HEADER) === internalDispatchToken()
    // Only an in-process caller can name itself, and only as one of the two
    // agent entry points: the header is meaningless without the isolate token.
    const origin = isMcp ? 'mcp' : internal ? (c.req.header(INTERNAL_ORIGIN_HEADER) === 'cron' ? 'cron' : 'chat') : 'ui'
    const caller = origin === 'ui' ? 'browser' : 'agent'

    c.set('userId', userId)
    c.set('caller', caller)
    c.set('origin', origin)

    // Runs as postgres superuser — bypasses RLS (intentional for tenant resolution)
    const db = createDb(c.env.DATABASE_URL)
    const [membership] = await db
      .select({
        tenantId: tenantMembers.tenantId,
        firstMcpConnectedAt: tenants.firstMcpConnectedAt,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      .where(eq(tenantMembers.userId, userId))
      .limit(1)

    // The tenant is created with the account, so no membership means the account is gone.
    if (!membership) {
      return c.json({ error: 'Account no longer exists' }, 401)
    }

    const tenantId = asTenantId(membership.tenantId)
    c.set('tenantId', tenantId)

    // IS NULL guard keeps the one-time stamp idempotent under concurrent requests.
    if (isMcp && membership.firstMcpConnectedAt === null) {
      const stamped = await db
        .update(tenants)
        .set({ firstMcpConnectedAt: new Date() })
        .where(and(eq(tenants.id, tenantId), isNull(tenants.firstMcpConnectedAt)))
        .returning({ id: tenants.id })
      if (stamped.length > 0) logFunnel({ event: 'mcp_connected', tenantId })
    }

    // Store raw db for downstream middleware (rlsMiddleware wraps it in a transaction)
    c.set('db', db)

    await next()
  },
)
