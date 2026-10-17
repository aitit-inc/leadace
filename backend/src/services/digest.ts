import { and, eq } from 'drizzle-orm'
import { projectSettings, projects } from '../db/schema'
import type { TenantRun } from '../db/rls'
import type { Edition } from '../domain/edition'
import type { ProjectId, TenantId } from '../domain/ids'
import { buildDigest, dayOf, dayStart } from '../domain/digest'
import { getDashboardSummary } from './dashboard'
import { notify, type NotifyCtx } from './notifications'
import { ok, err, type ServiceResult } from './result'
import { getTenantOwnerUserId } from './tenants'

export type DigestCtx = NotifyCtx & { edition: Edition }

// Sent once: the notification's reference carries the day, and a sent digest
// moves the cursor the next one reports from.
export async function sendCycleDigest(
  run: TenantRun,
  tenantId: TenantId,
  ctx: DigestCtx,
  projectId: ProjectId,
): Promise<ServiceResult<{ sent: boolean }>> {
  const today = dayOf(new Date())
  // The cursor is a day boundary: what the digest reports is whole days.
  const windowEnd = dayStart(today)
  const prepared = await run(async (db) => {
    const owner = await getTenantOwnerUserId(db, tenantId)
    if (!owner) return err('INTERNAL_ERROR', 'Tenant has no owner')
    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(and(eq(projects.tenantId, tenantId), eq(projects.id, projectId)))
      .limit(1)
    if (!project) return err('NOT_FOUND', 'Project not found')
    const [settings] = await db
      .select({ since: projectSettings.insightDigestSince })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1)
    if (!settings) return err('NOT_FOUND', 'Project settings not found')

    // The window the dashboard opens on, so the email and the screen agree.
    const summary = await getDashboardSummary(db, tenantId, owner, ctx.edition, projectId, { period: '30d' })
    if (!summary.ok) return summary
    return ok(buildDigest({ projectName: project.name, sinceDay: dayOf(settings.since), today, summary: summary.value }))
  })
  if (!prepared.ok) return prepared
  const digest = prepared.value
  if (digest === null) return ok({ sent: false })

  const notified = await notify(run, tenantId, ctx, {
    category: 'insight',
    reference: `digest:${projectId}:${today}`,
    subject: digest.subject,
    body: digest.body,
    link: '/dashboard',
  })
  if (!notified.ok) return notified
  // A crash between the notification's insert and its email leaves the row
  // behind; the cursor stays put so tomorrow's digest reports the window again
  // rather than losing it.
  if (!notified.value.recorded) return ok({ sent: false })

  await run((db) =>
    db
      .update(projectSettings)
      .set({ insightDigestSince: windowEnd })
      .where(eq(projectSettings.projectId, projectId)),
  )
  return ok({ sent: true })
}
