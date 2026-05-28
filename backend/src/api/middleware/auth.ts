import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { verifySupabaseJwt } from '../../auth/verify-jwt'
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
    const userId = await verifySupabaseJwt(token, c.env.SUPABASE_JWT_SECRET, c.env.SUPABASE_URL)

    if (!userId) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    c.set('userId', userId)

    // Runs as postgres superuser — bypasses RLS (intentional for tenant resolution)
    const db = createDb(c.env.DATABASE_URL)
    const [membership] = await db
      .select({ tenantId: tenantMembers.tenantId })
      .from(tenantMembers)
      .where(eq(tenantMembers.userId, userId))
      .limit(1)

    if (membership) {
      c.set('tenantId', asTenantId(membership.tenantId))
    } else {
      // Auto-provision tenant for new users.
      // Wrapped in a transaction so a UNIQUE(user_id) violation on tenant_members
      // (race against a concurrent first request) rolls back the tenant/plan rows too.
      // On conflict, re-select the existing membership and use that tenantId.
      const tenantId = generateId()
      const now = new Date()
      try {
        await db.transaction(async (tx) => {
          await tx.insert(tenants).values({ id: tenantId, name: 'My Workspace', createdAt: now })
          await tx.insert(tenantPlans).values({ tenantId, plan: 'free', createdAt: now, updatedAt: now })
          await tx.insert(tenantMembers).values({ tenantId, userId, role: 'owner', createdAt: now })
        })
        c.set('tenantId', asTenantId(tenantId))
      } catch (e) {
        // Only the UNIQUE(user_id) race (Postgres 23505) is recoverable by
        // re-reading the winner's tenantId. Anything else (schema error,
        // connection failure, RLS misconfig) gets rethrown so it surfaces as
        // a real 500 instead of being papered over by the re-select.
        if (!isUniqueViolation(e)) throw e
        const [existing] = await db
          .select({ tenantId: tenantMembers.tenantId })
          .from(tenantMembers)
          .where(eq(tenantMembers.userId, userId))
          .limit(1)
        if (!existing) throw e
        c.set('tenantId', asTenantId(existing.tenantId))
      }
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

// postgres.js surfaces Postgres errors as objects carrying SQLSTATE in `code`.
// 23505 = unique_violation — the only failure we expect from the tenant
// auto-provision transaction and recover from by re-reading the winner row.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === '23505'
}
