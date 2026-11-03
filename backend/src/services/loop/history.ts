import { and, eq, gte } from 'drizzle-orm'
import type { Db } from '../../db/connection'
import { proposals } from '../../db/schema'
import { buildHistory, historySince, type HistoryRow } from '../../domain/history'
import type { ProjectId, ProjectRef, TenantId } from '../../domain/ids'
import { listMessageVariantsById } from '../message-variants'
import { loadLeverConfig } from '../project-settings'
import { resolveProject } from '../projects'
import { ok, type ServiceResult } from '../result'
import { listChanges } from './change'
import { activityDays, historyOutcomes } from './observe'

// The rows of the last `days` UTC days, or the whole record. Their results count
// all of what followed, however far back the rows are cut.
export async function getHistoryById(db: Db, tenantId: TenantId, projectId: ProjectId, days: number | null, now: Date = new Date()): Promise<ServiceResult<HistoryRow[]>> {
  const since = days === null ? new Date(0) : historySince(days, now)
  const config = await loadLeverConfig(db, projectId)
  const [changes, variants, raised, activity, outcomes] = await Promise.all([
    listChanges(db, projectId, since),
    listMessageVariantsById(db, tenantId, projectId),
    db
      .select({ title: proposals.title, status: proposals.status, change: proposals.change, createdAt: proposals.createdAt })
      .from(proposals)
      .where(and(eq(proposals.projectId, projectId), gte(proposals.createdAt, since))),
    activityDays(db, projectId, since),
    historyOutcomes(db, projectId, config, now),
  ])
  if (!variants.ok) return variants
  return ok(buildHistory(changes, variants.value.variants, raised, activity, outcomes))
}

export async function getHistory(db: Db, tenantId: TenantId, projectRef: ProjectRef, days: number | null): Promise<ServiceResult<HistoryRow[]>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  return getHistoryById(db, tenantId, resolved.value, days)
}
