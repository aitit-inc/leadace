import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { outreachLogs, projectSettings, sendingIdentities, tenantPlans } from '../db/schema'
import {
  deriveAttentionItems,
  type AttentionInput,
  type AttentionItem,
} from '../domain/attention'
import type { VitalsAssessment } from '../domain/loop/frame'
import type { Edition } from '../domain/edition'
import type { ProjectId, TenantId } from '../domain/ids'
import { inboxTestHolds } from '../domain/inbox-test'
import { hostedChannels } from '../domain/outbound-channel'
import { getPlanInfo } from './billing'
import { isContactQuotaExhausted, isFoundQuotaExhausted, type ProspectQuota } from './plan-limits'
import { getCredentialsStatus } from './google-auth'
import { ok, type ServiceResult } from './result'
import { getOnboardingStatus, getTenantComplianceStatus } from './tenants'
import { getOutboundMode, loadProjectOutboundAllowlist } from './project-settings'
import { listReachable } from './prospects'

type TenantAttention = { input: Omit<AttentionInput, 'project'>; quota: ProspectQuota }

// Shared by the dashboard and /me/attention so every surface gets one judgment.
async function loadTenantAttention(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
): Promise<ServiceResult<TenantAttention>> {
  const [complianceRes, onboardingRes, gmailRes, planRes, emailDrafts, sendModeProjects, identities, vitalsRows, [subscription]] = await Promise.all([
    getTenantComplianceStatus(db, tenantId),
    getOnboardingStatus(db, tenantId),
    getCredentialsStatus(db, tenantId, userId),
    getPlanInfo(db, tenantId, edition),
    db
      .select({ id: outreachLogs.id })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.tenantId, tenantId), eq(outreachLogs.status, 'pending_review'), eq(outreachLogs.channel, 'email')))
      .limit(1),
    db
      .select({ projectId: projectSettings.projectId })
      .from(projectSettings)
      .where(and(eq(projectSettings.tenantId, tenantId), eq(projectSettings.outboundMode, 'send')))
      .limit(1),
    db
      .select({
        fromEmail: sendingIdentities.fromEmail,
        provider: sendingIdentities.provider,
        parentIdentityId: sendingIdentities.parentIdentityId,
        scope: sendingIdentities.scope,
        authRevokedAt: sendingIdentities.authRevokedAt,
        pollFailingSince: sendingIdentities.pollFailingSince,
        lastPollError: sendingIdentities.lastPollError,
        sendRefusal: sendingIdentities.sendRefusal,
        inboxTestResult: sendingIdentities.inboxTestResult,
      })
      .from(sendingIdentities)
      .where(eq(sendingIdentities.tenantId, tenantId)),
    // Newest decision row per project only — an older futile day cleared by a
    // later tick must not alarm. ::text because the prod transaction pooler
    // hands raw jsonb projections back as strings; parse explicitly.
    db.execute<{ projectId: string; projectName: string; vitals: string | null }>(sql`
      SELECT DISTINCT ON (ld.project_id) ld.project_id AS "projectId", p.name AS "projectName", (ld.decision->'vitals')::text AS vitals
      FROM lever_decisions ld JOIN projects p ON p.id = ld.project_id
      WHERE ld.tenant_id = ${tenantId}
      ORDER BY ld.project_id, ld.cycle_date DESC
    `),
    db
      .select({ subscriptionId: tenantPlans.stripeSubscriptionId })
      .from(tenantPlans)
      .where(eq(tenantPlans.tenantId, tenantId))
      .limit(1),
  ])
  if (!complianceRes.ok) return complianceRes
  if (!onboardingRes.ok) return onboardingRes
  if (!gmailRes.ok) return gmailRes
  if (!planRes.ok) return planRes

  const futileProjects = Array.from(vitalsRows).flatMap((row) => {
    if (row.vitals === null) return []
    const v = JSON.parse(row.vitals) as VitalsAssessment
    return v.verdict === 'futile'
      ? [{ projectId: row.projectId, projectName: row.projectName, sends: v.sends, engaged: v.engaged }]
      : []
  })

  const quota = planRes.value.quota
  const autoTopUp = quota.kind === 'capped' ? quota.credits?.autoTopUp : undefined
  const input: TenantAttention['input'] = {
    hasProject: onboardingRes.value.hasProject,
    compliance: { ready: complianceRes.value.ready, missing: complianceRes.value.missing },
    gmailConnected: gmailRes.value.connected,
    emailDraftsWaiting: emailDrafts.length > 0,
    sendsWithoutReview: sendModeProjects.length > 0,
    // A Send-As alias has no credentials or inbox of its own (its parent reports
    // those) but it does have its own cap, so a refusal below is its own.
    identities: identities.filter((i) => i.parentIdentityId === null),
    refusedMailboxes: identities.flatMap((i) => (i.sendRefusal ? [{ fromEmail: i.fromEmail, sentThatDay: i.sendRefusal.sentThatDay }] : [])),
    spamHeldMailboxes: identities.flatMap((i) =>
      i.inboxTestResult && inboxTestHolds(i.inboxTestResult)
        ? [{ fromEmail: i.fromEmail, spam: i.inboxTestResult.spam, delivered: i.inboxTestResult.inbox + i.inboxTestResult.spam }]
        : [],
    ),
    futileProjects,
    quota: {
      exhausted: isContactQuotaExhausted(quota) ? 'contacted' : null,
      constraint: quota.kind === 'capped' ? quota.window : null,
    },
    billing: { plan: planRes.value.plan, holdsSubscription: Boolean(subscription?.subscriptionId) },
    creditTopUpFailedAt: autoTopUp && !autoTopUp.enabled ? autoTopUp.failedAt : null,
    now: new Date(),
  }
  return ok({ input, quota })
}

export async function listTenantAttention(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
): Promise<ServiceResult<AttentionItem[]>> {
  const tenant = await loadTenantAttention(db, tenantId, userId, edition)
  if (!tenant.ok) return tenant
  return ok(deriveAttentionItems({ ...tenant.value.input, project: null }))
}

// A spent found allowance stops new outreach only once the project has no
// first touch left that the hosted agent can make (the daily cycle's own test).
async function listRanDry(db: Db, tenantId: TenantId, edition: Edition, projectId: ProjectId): Promise<boolean> {
  const mode = await getOutboundMode(db, projectId)
  const reachable = await listReachable(db, tenantId, edition, projectId, { limit: 1, arm: 'first', channels: hostedChannels(mode) })
  return reachable.ok && reachable.value.withinChannels === 0
}

// No per-lead seen/handled state exists, so this is "recent" rather than a true unread count.
const HOT_LEADS_WINDOW_DAYS = 7

export async function listProjectAttention(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
  projectId: ProjectId,
  now: Date,
): Promise<ServiceResult<AttentionItem[]>> {
  const hotSinceIso = new Date(now.getTime() - HOT_LEADS_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const [tenant, allowlist, [pendingDrafts], hotLeads] = await Promise.all([
    loadTenantAttention(db, tenantId, userId, edition),
    loadProjectOutboundAllowlist(db, projectId),
    db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'pending_review'))),
    // Distinct prospects who asked for a meeting. Self-serve signups
    // (signup_clicked) are excluded — the item routes to /responses (the
    // meeting/reply queue), where a signup wouldn't appear.
    db.execute<{ count: string | number }>(sql`
      WITH ev AS (
        SELECT ol.prospect_id AS pid
        FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
        WHERE ol.project_id = ${projectId} AND r.response_type = 'meeting_request'
          AND r.received_at >= ${hotSinceIso}::timestamptz
        UNION
        SELECT s.prospect_id AS pid
        FROM inquiry_sessions s JOIN outreach_logs ol ON ol.id = s.outreach_log_id
        WHERE ol.project_id = ${projectId} AND s.outcome = 'lead'
          AND s.opened_at >= ${hotSinceIso}::timestamptz
      )
      SELECT COUNT(DISTINCT pid)::int AS count FROM ev`),
  ])
  if (!tenant.ok) return tenant
  const { input, quota } = tenant.value
  const foundStopped = input.quota.exhausted === null && isFoundQuotaExhausted(quota) && (await listRanDry(db, tenantId, edition, projectId))
  return ok(
    deriveAttentionItems({
      ...input,
      quota: foundStopped ? { ...input.quota, exhausted: 'found' } : input.quota,
      // Own project only — the tenant-wide bell still names every futile project.
      futileProjects: input.futileProjects.filter((p) => p.projectId === projectId),
      project: {
        outboundChannelsConfigured: allowlist.outboundChannels.length > 0,
        pendingDrafts: Number(pendingDrafts?.count ?? 0),
        hotLeadsRecent: Number(Array.from(hotLeads)[0]?.count ?? 0),
      },
    }),
  )
}
