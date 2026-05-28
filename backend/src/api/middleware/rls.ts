import { createMiddleware } from 'hono/factory'
import { sql } from 'drizzle-orm'
import type { Db } from '../../db/connection'
import type { Env, Variables } from '../types'

/**
 * RLS middleware: wraps the request in a transaction with tenant isolation.
 *
 * Must run AFTER authMiddleware (requires tenantId and db in context).
 *
 * Inside the transaction:
 *   SET LOCAL ROLE app_rls    — switches to a role that has RLS enforced
 *   SET LOCAL app.tenant_id   — tells RLS policies which tenant to allow
 *
 * Auth middleware and stripe webhook run as the postgres superuser (no RLS).
 */
export const rlsMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const tenantId = c.get('tenantId')
    const db = c.get('db')

    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE app_rls`)
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`)
      // Overwrite context with the transaction (same query API as Db)
      c.set('db', tx as unknown as Db)
      await next()
    })
  },
)
