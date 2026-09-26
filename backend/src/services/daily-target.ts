import { eq } from 'drizzle-orm'
import { projectSettings } from '../db/schema'
import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import { creditsCoverOverage, USAGE_PRICE_CENTS } from '../domain/credits'
import {
  planPace,
  resolveDailyTarget,
  runnableNewProspects,
  type DailyLimit,
  type DailyTargetSource,
  type PaceInput,
  type PlanPace,
} from '../domain/daily-target'
import { ok, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { pickProjectMailbox } from './mailbox'
import { getOutboundMode } from './project-settings'
import { getRemainingProspectQuotaForPlan, getTenantPlan } from './plan-limits'

export async function loadPlanPace(db: Db, tenantId: TenantId, edition: Edition, now: Date): Promise<PlanPace> {
  const tp = await getTenantPlan(db, tenantId, edition)
  const quota = await getRemainingProspectQuotaForPlan(db, tenantId, tp)
  const input: PaceInput =
    quota.kind === 'unlimited'
      ? { kind: 'unlimited' }
      : quota.window === 'lifetime' || tp.currentPeriodStart === null
        ? { kind: 'lifetime', remaining: quota.contacted.remaining }
        : {
            kind: 'monthly',
            remaining: quota.contacted.remaining,
            limit: quota.contacted.limit,
            periodStart: tp.currentPeriodStart,
            periodEnd: tp.currentPeriodEnd ?? oneMonthAfter(tp.currentPeriodStart),
            creditsPay: creditsCoverOverage(quota.credits, USAGE_PRICE_CENTS.contacted),
          }
  return planPace(input, now)
}

function oneMonthAfter(t: Date): Date {
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes()))
}

export async function loadDailyNewProspects(db: Db, projectId: ProjectId): Promise<number | null> {
  const [row] = await db
    .select({ dailyNewProspects: projectSettings.dailyNewProspects })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  if (!row) throw new Error(`Invariant: project_settings row missing for project ${projectId}`)
  return row.dailyNewProspects
}

export type DailyTarget = {
  // The project's number; null = the plan's pace.
  setting: number | null
  // What applies while setting is null.
  planDefault: number
  // null = the plan does not cap the day.
  planCap: number | null
  target: number
  source: DailyTargetSource
  // The project's mailboxes' safe sends per day, follow-ups included; null
  // when drafts wait for review and the mailboxes do not bound them.
  mailboxCapacity: number | null
  runnable: number
  limitedBy: DailyLimit
}

export async function getDailyTarget(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  projectRef: ProjectRef,
): Promise<ServiceResult<DailyTarget>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  const [setting, pace, mailbox, mode] = await Promise.all([
    loadDailyNewProspects(db, projectId),
    loadPlanPace(db, tenantId, edition, new Date()),
    pickProjectMailbox(db, tenantId, projectId),
    getOutboundMode(db, projectId),
  ])
  const target = resolveDailyTarget(setting, pace)
  const planDefault = resolveDailyTarget(null, pace).count
  const mailboxCapacity = mode !== 'send' ? null : mailbox.kind === 'no_mailbox' ? 0 : mailbox.cap
  const runnable = runnableNewProspects(target.count, mailboxCapacity, pace)
  return ok({
    setting,
    planDefault,
    planCap: pace?.cap ?? null,
    target: target.count,
    source: target.source,
    mailboxCapacity,
    runnable: runnable.count,
    limitedBy: runnable.limitedBy,
  })
}
