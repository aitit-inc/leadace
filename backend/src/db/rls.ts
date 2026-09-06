import { sql } from 'drizzle-orm'
import { withDb, type Db } from './connection'

// One RLS-pinned transaction around `fn`: the request middleware wraps a
// request in it; the chat stream and the job path (raw connections, no
// request) open one per self-contained mutation so a service's writes land
// together or not at all, under the same RLS backstop the API path has.
export async function runWithRls<T>(db: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE app_rls`)
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`)
    return fn(tx as unknown as Db)
  })
}

// Holding one connection across a chat turn or a job step fails on the deployed
// runtime: the first write after a tool call raised CONNECTION_CLOSED every
// time, never once against a direct database.
export function withTenantConnection<T>(databaseUrl: string, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return withDb(databaseUrl, (db) => runWithRls(db, tenantId, fn))
}
