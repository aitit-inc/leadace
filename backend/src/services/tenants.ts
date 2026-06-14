import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { tenants } from '../db/schema'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'

// No closed-list validation here because the LLM / user may legitimately
// store a country we haven't implemented send rules for yet; the send-time
// guardrail (`isAllowedSendCountry`) enforces the current allowlist.
const COUNTRY_CODE_REGEX = /^[A-Z]{2}$/

export const updateTenantSettingsSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    legalName: z.string().min(1).max(200).nullable().optional(),
    physicalAddress: z.string().min(5).max(500).nullable().optional(),
    defaultSenderCountry: z
      .string()
      .regex(COUNTRY_CODE_REGEX, 'Country must be ISO 3166-1 alpha-2 (2 upper-case letters)')
      .nullable()
      .optional(),
    privacyPolicyUrl: z.url().max(500).nullable().optional(),
  })
  .strict()
export type UpdateTenantSettingsPatch = z.infer<typeof updateTenantSettingsSchema>

export type TenantSettingsRow = {
  id: string
  name: string
  legalName: string | null
  physicalAddress: string | null
  defaultSenderCountry: string | null
  privacyPolicyUrl: string | null
}

const settingsCols = {
  id: tenants.id,
  name: tenants.name,
  legalName: tenants.legalName,
  physicalAddress: tenants.physicalAddress,
  defaultSenderCountry: tenants.defaultSenderCountry,
  privacyPolicyUrl: tenants.privacyPolicyUrl,
}

export async function loadTenantSettings(
  db: Db,
  tenantId: TenantId,
): Promise<ServiceResult<TenantSettingsRow>> {
  const [row] = await db
    .select(settingsCols)
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  // Auto-provisioned by auth middleware on first request, so a missing row
  // is a genuine system error.
  if (!row) return err('INTERNAL_ERROR', 'Tenant row missing')
  return ok(row)
}

// Straight UPDATE (not upsert) — auth middleware guarantees the row exists.
export async function updateTenantSettings(
  db: Db,
  tenantId: TenantId,
  patch: UpdateTenantSettingsPatch,
): Promise<ServiceResult<TenantSettingsRow>> {
  const updateSet = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.legalName !== undefined ? { legalName: patch.legalName } : {}),
    ...(patch.physicalAddress !== undefined ? { physicalAddress: patch.physicalAddress } : {}),
    ...(patch.defaultSenderCountry !== undefined
      ? { defaultSenderCountry: patch.defaultSenderCountry?.toUpperCase() ?? null }
      : {}),
    ...(patch.privacyPolicyUrl !== undefined ? { privacyPolicyUrl: patch.privacyPolicyUrl } : {}),
  }

  if (Object.keys(updateSet).length === 0) {
    return loadTenantSettings(db, tenantId)
  }

  const [row] = await db
    .update(tenants)
    .set(updateSet)
    .where(eq(tenants.id, tenantId))
    .returning(settingsCols)

  if (!row) return err('INTERNAL_ERROR', 'Tenant row missing')
  return ok(row)
}

// Refuses the send when legal_name / physical_address / default_sender_country
// are missing — CAN-SPAM physical address + sender identity, CASL §6 sender
// identification. privacy_policy_url is optional and never blocking — it is
// only meaningful as the sender's (controller's) GDPR Art.14 notice to UK/EU
// individual recipients (no current send-target country requires it).
export type TenantComplianceProjection = {
  legalName: string
  physicalAddress: string
  defaultSenderCountry: string
  privacyPolicyUrl: string | null
}

// privacyPolicyUrl is intentionally absent — set, it appears in the footer but
// never blocks a send.
export const COMPLIANCE_FIELDS = ['legalName', 'physicalAddress', 'defaultSenderCountry'] as const
export type ComplianceField = (typeof COMPLIANCE_FIELDS)[number]

export function computeComplianceMissing(fields: {
  legalName: string | null
  physicalAddress: string | null
  defaultSenderCountry: string | null
}): ComplianceField[] {
  const missing: ComplianceField[] = []
  if (!fields.legalName) missing.push('legalName')
  if (!fields.physicalAddress) missing.push('physicalAddress')
  if (!fields.defaultSenderCountry) missing.push('defaultSenderCountry')
  return missing
}

export async function assertTenantComplianceReady(
  db: Db,
  tenantId: TenantId,
): Promise<ServiceResult<TenantComplianceProjection>> {
  const result = await loadTenantSettings(db, tenantId)
  if (!result.ok) return result

  const row = result.value
  const missing = computeComplianceMissing(row)

  if (missing.length > 0) {
    return err(
      'PRECONDITION_FAILED',
      'Tenant compliance settings incomplete',
      `Set the following in Workspace Settings before sending: ${missing.join(', ')}`,
      { missing },
    )
  }

  return ok({
    legalName: row.legalName!,
    physicalAddress: row.physicalAddress!,
    defaultSenderCountry: row.defaultSenderCountry!,
    privacyPolicyUrl: row.privacyPolicyUrl,
  })
}

// Same field set as `assertTenantComplianceReady` but never errors — returns
// { ready, missing } so callers branch on the boolean without parsing a
// PRECONDITION_FAILED envelope. Tiny response so the skill can call it
// cheaply on every run.
export type TenantComplianceStatus = {
  ready: boolean
  missing: ComplianceField[]
}

export async function getTenantComplianceStatus(
  db: Db,
  tenantId: TenantId,
): Promise<ServiceResult<TenantComplianceStatus>> {
  const result = await loadTenantSettings(db, tenantId)
  if (!result.ok) return result

  const missing = computeComplianceMissing(result.value)

  return ok({ ready: missing.length === 0, missing })
}

export type OnboardingStatus = {
  mcpConnected: boolean
}

export async function getOnboardingStatus(
  db: Db,
  tenantId: TenantId,
): Promise<ServiceResult<OnboardingStatus>> {
  const [row] = await db
    .select({ firstMcpConnectedAt: tenants.firstMcpConnectedAt })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1)
  if (!row) return err('INTERNAL_ERROR', 'Tenant row missing')
  return ok({ mcpConnected: row.firstMcpConnectedAt !== null })
}
