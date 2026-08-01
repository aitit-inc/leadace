import { eq } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { sendingIdentities } from '../db/schema'
import { deriveAlerts, type Alert } from '../domain/alerts'
import type { TenantId } from '../domain/ids'

export async function listAlerts(db: Db, tenantId: TenantId): Promise<Alert[]> {
  const rows = await db
    .select({
      fromEmail: sendingIdentities.fromEmail,
      provider: sendingIdentities.provider,
      scope: sendingIdentities.scope,
      authRevokedAt: sendingIdentities.authRevokedAt,
    })
    .from(sendingIdentities)
    .where(eq(sendingIdentities.tenantId, tenantId))
  return deriveAlerts(rows)
}
