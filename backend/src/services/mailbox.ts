import type { Db } from '../db/connection'
import type { ProjectRef, TenantId } from '../domain/ids'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { resolveSendingIdentityId } from '../auth/google'
import { getMailboxHealth, type MailboxHealth } from './plan-limits'

// Resolves the project's sending identity first so the agent sees the health of
// the same mailbox the send path enforces, not a fixed gmail row.
export async function getProjectMailboxHealth(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  now: Date = new Date(),
): Promise<ServiceResult<MailboxHealth>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const identityId = await resolveSendingIdentityId(db, { tenantId, projectId: resolved.value })
  return ok(await getMailboxHealth(db, tenantId, identityId, now))
}
