import { createMiddleware } from 'hono/factory'
import { and, eq, isNull } from 'drizzle-orm'
import { MCP_AUDIENCE, verifyJwt } from '../../auth/verify-jwt'
import { randomFromAlphabet } from '../../auth/random-id'
import { createDb } from '../../db/connection'
import { tenantMembers, tenantPlans, tenants } from '../../db/schema'
import { asTenantId } from '../../domain/ids'
import type { Env, Variables } from '../types'

export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ error: 'Unauthorized' }, 401)
    }

    const token = authHeader.slice(7)
    const verified = await verifyJwt(token, c.env.SUPABASE_JWT_SECRET, c.env.SUPABASE_URL)

    if (!verified) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    const userId = verified.sub
    const isMcp = verified.aud === MCP_AUDIENCE

    c.set('userId', userId)

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

    let tenantId: string
    let mcpStamped: boolean
    if (membership) {
      tenantId = membership.tenantId
      mcpStamped = membership.firstMcpConnectedAt !== null
    } else {
      // Wrapped in a transaction so a UNIQUE(user_id) violation on tenant_members
      // (race against a concurrent first request) rolls back the tenant/plan rows too.
      const newTenantId = generateId()
      const now = new Date()
      try {
        await db.transaction(async (tx) => {
          await tx.insert(tenants).values({ id: newTenantId, name: 'My Workspace', createdAt: now })
          await tx.insert(tenantPlans).values({ tenantId: newTenantId, plan: 'free', createdAt: now, updatedAt: now })
          await tx.insert(tenantMembers).values({ tenantId: newTenantId, userId, role: 'owner', createdAt: now })
        })
        tenantId = newTenantId
        // An MCP-first signup is stamped by the shared post-block below, not inline.
        mcpStamped = false
      } catch (e) {
        // Only the UNIQUE(user_id) race is recoverable by re-reading the winner's
        // tenantId; anything else rethrows so it surfaces as a real 500.
        if (!isUniqueViolation(e)) throw e
        const [existing] = await db
          .select({
            tenantId: tenantMembers.tenantId,
            firstMcpConnectedAt: tenants.firstMcpConnectedAt,
          })
          .from(tenantMembers)
          .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
          .where(eq(tenantMembers.userId, userId))
          .limit(1)
        if (!existing) throw e
        tenantId = existing.tenantId
        mcpStamped = existing.firstMcpConnectedAt !== null
      }
    }

    c.set('tenantId', asTenantId(tenantId))

    // IS NULL guard keeps the one-time stamp idempotent under concurrent requests.
    if (isMcp && !mcpStamped) {
      await db
        .update(tenants)
        .set({ firstMcpConnectedAt: new Date() })
        .where(and(eq(tenants.id, tenantId), isNull(tenants.firstMcpConnectedAt)))
    }

    // Store raw db for downstream middleware (rlsMiddleware wraps it in a transaction)
    c.set('db', db)

    await next()
  },
)

const TENANT_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

function generateId(length = 21): string {
  return randomFromAlphabet(TENANT_ID_ALPHABET, length)
}

// postgres.js surfaces Postgres errors as objects carrying SQLSTATE in `code`;
// 23505 = unique_violation.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'
}
