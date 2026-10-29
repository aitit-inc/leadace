import { TransactionRollbackError } from 'drizzle-orm'
import { createMiddleware } from 'hono/factory'
import { runWithRls } from '../../db/rls'
import { withPaidCallScope } from '../../services/paid-calls'
import type { Env, Variables } from '../types'

/**
 * Must run AFTER authMiddleware (requires tenantId and db in context).
 *
 * Inside the transaction:
 *   SET LOCAL ROLE app_rls    — switches to a role that has RLS enforced
 *   SET LOCAL app.tenant_id   — tells RLS policies which tenant to allow
 *
 * Auth middleware runs as the postgres superuser (no RLS); the Stripe webhook
 * finds its tenant that way and writes through runWithRls.
 */
export const rlsMiddleware = createMiddleware<{ Bindings: Env; Variables: Variables }>(
  async (c, next) => {
    const tenantId = c.get('tenantId')
    const db = c.get('db')
    const afterCommit: Array<() => Promise<void>> = []
    c.set('afterCommit', afterCommit)

    try {
      await withPaidCallScope({ databaseUrl: c.env.DATABASE_URL, tenantId }, () => runWithRls(db, tenantId, async (tx) => {
        // Overwrite context with the transaction (same query API as Db)
        c.set('db', tx)
        await next()
        // Hono's onError already handled a handler throw and next() resolved, so
        // roll back here; rethrowing c.error would run onError twice.
        if (c.error) throw new TransactionRollbackError()
      }))
    } catch (e) {
      if (!(e instanceof TransactionRollbackError)) throw e
      return
    }
    for (const task of afterCommit) c.executionCtx.waitUntil(task())
  },
)
