import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { sendingIdentities } from '../db/schema'
import {
  deriveAttentionItems,
  type AttentionInput,
  type AttentionItem,
} from '../domain/attention'
import type { VitalsAssessment } from '../domain/vital-signs'
import type { Edition } from '../domain/edition'
import type { TenantId } from '../domain/ids'
import { getPlanInfo } from './billing'
import { isContactQuotaExhausted } from './plan-limits'
import { getCredentialsStatus } from './google-auth'
import { ok, type ServiceResult } from './result'
import { getOnboardingStatus, getTenantComplianceStatus } from './tenants'

export type TenantAttentionInput = Omit<AttentionInput, 'project'>

// Shared by the dashboard and /me/attention so every surface gets one judgment.
export async function loadTenantAttentionInput(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
): Promise<ServiceResult<TenantAttentionInput>> {
  const [complianceRes, onboardingRes, gmailRes, planRes, identities, vitalsRows] = await Promise.all([
    getTenantComplianceStatus(db, tenantId),
    getOnboardingStatus(db, tenantId),
    getCredentialsStatus(db, tenantId, userId),
    getPlanInfo(db, tenantId, edition),
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
  ])
  if (!complianceRes.ok) return complianceRes
  if (!onboardingRes.ok) return onboardingRes
  if (!gmailRes.ok) return gmailRes
  if (!planRes.ok) return planRes

  const futileProjects = Array.from(vitalsRows).flatMap((row) => {
    if (row.vitals === null) return []
    const v = JSON.parse(row.vitals) as VitalsAssessment
    return v.verdict === 'futile'
      ? [{ projectId: row.projectId, projectName: row.projectName, sends: v.sends, replies: v.replies }]
      : []
  })

  const quota = planRes.value.quota
  return ok({
    hasProject: onboardingRes.value.hasProject,
    compliance: { ready: complianceRes.value.ready, missing: complianceRes.value.missing },
    gmailConnected: gmailRes.value.connected,
    // A Send-As alias has no credentials or inbox of its own (its parent reports
    // those) but it does have its own cap, so a refusal below is its own.
    identities: identities.filter((i) => i.parentIdentityId === null),
    refusedMailboxes: identities.flatMap((i) => (i.sendRefusal ? [{ fromEmail: i.fromEmail, sentThatDay: i.sendRefusal.sentThatDay }] : [])),
    futileProjects,
    quota: {
      exhausted: isContactQuotaExhausted(quota),
      constraint: quota.kind === 'capped' ? quota.window : null,
    },
    creditTopUpFailedAt: quota.kind === 'capped' ? quota.credits?.autoTopUp.failedAt ?? null : null,
    now: new Date(),
  })
}

export async function listTenantAttention(
  db: Db,
  tenantId: TenantId,
  userId: string,
  edition: Edition,
): Promise<ServiceResult<AttentionItem[]>> {
  const input = await loadTenantAttentionInput(db, tenantId, userId, edition)
  if (!input.ok) return input
  return ok(deriveAttentionItems({ ...input.value, project: null }))
}
