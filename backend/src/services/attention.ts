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
        scope: sendingIdentities.scope,
        authRevokedAt: sendingIdentities.authRevokedAt,
        pollFailingSince: sendingIdentities.pollFailingSince,
        lastPollError: sendingIdentities.lastPollError,
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

  const quota = planRes.value.outreach
  return ok({
    mcpConnected: onboardingRes.value.mcpConnected,
    compliance: { ready: complianceRes.value.ready, missing: complianceRes.value.missing },
    gmailConnected: gmailRes.value.connected,
    identities,
    futileProjects,
    quota: {
      exhausted: quota.kind === 'capped' && quota.remaining <= 0,
      constraint: quota.kind === 'capped' ? quota.bindingConstraint : null,
    },
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
