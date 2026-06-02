import { z } from 'zod'
import { eq } from 'drizzle-orm'
import {
  projectSettings,
  OUTBOUND_MODES,
  OUTBOUND_CHANNELS,
  INQUIRY_CTA_TYPES,
  type OutboundMode,
  type OutboundChannel,
  type InquiryCtaType,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { requireProject } from './projects'
import { isHttpsUrl, HTTPS_ONLY_MSG } from '../domain/url'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'

// 6-digit hex only; 3-digit shorthand and named colors rejected so the
// frontend swatch / preview is deterministic.
const BRAND_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/

export const updateSettingsSchema = z
  .object({
    outboundMode: z.enum(OUTBOUND_MODES).optional(),
    senderEmailAlias: z.email().nullable().optional(),
    senderDisplayName: z.string().min(1).max(200).nullable().optional(),
    senderCompanyName: z.string().min(1).max(200).nullable().optional(),
    senderJobTitle: z.string().min(1).max(200).nullable().optional(),
    unsubscribeEnabled: z.boolean().optional(),
    inquiryLandingEnabled: z.boolean().optional(),
    inquiryChatBrief: z.string().max(4000).nullable().optional(),
    inquiryOneLiner: z.string().max(140).nullable().optional(),
    inquiryVideoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryPdfUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryBrandColor: z.string().regex(BRAND_COLOR_REGEX).nullable().optional(),
    inquiryBrandLogoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryCtaType: z.enum(INQUIRY_CTA_TYPES).optional(),
    inquiryCtaUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    // Bounds keep the skill / SaaS UI from pathological values that would
    // either spam (low) or freeze pipelines (very high).
    maxReapproachCycles: z.coerce.number().int().min(1).max(10).optional(),
    unspecifiedRecontactWindowMonths: z.coerce.number().int().min(1).max(24).optional(),
    noResponseRecycleDays: z.coerce.number().int().min(7).max(365).optional(),
    outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).optional(),
    targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).optional(),
  })
  .strict()
export type UpdateSettingsPatch = z.infer<typeof updateSettingsSchema>

// The settings row is seeded on project creation and backfilled for existing
// projects, so its absence is an invariant violation, not "not configured yet".
function assertSettingsRow<T>(row: T | undefined, projectId: ProjectId): T {
  if (!row) {
    throw new Error(`Invariant: project_settings row missing for project ${projectId}`)
  }
  return row
}

const settingsCols = {
  projectId: projectSettings.projectId,
  outboundMode: projectSettings.outboundMode,
  senderEmailAlias: projectSettings.senderEmailAlias,
  senderDisplayName: projectSettings.senderDisplayName,
  senderCompanyName: projectSettings.senderCompanyName,
  senderJobTitle: projectSettings.senderJobTitle,
  unsubscribeEnabled: projectSettings.unsubscribeEnabled,
  inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
  inquiryChatBrief: projectSettings.inquiryChatBrief,
  inquiryOneLiner: projectSettings.inquiryOneLiner,
  inquiryVideoUrl: projectSettings.inquiryVideoUrl,
  inquiryPdfUrl: projectSettings.inquiryPdfUrl,
  inquiryBrandColor: projectSettings.inquiryBrandColor,
  inquiryBrandLogoUrl: projectSettings.inquiryBrandLogoUrl,
  inquiryCtaType: projectSettings.inquiryCtaType,
  inquiryCtaUrl: projectSettings.inquiryCtaUrl,
  maxReapproachCycles: projectSettings.maxReapproachCycles,
  unspecifiedRecontactWindowMonths: projectSettings.unspecifiedRecontactWindowMonths,
  noResponseRecycleDays: projectSettings.noResponseRecycleDays,
  outboundChannels: projectSettings.outboundChannels,
  targetCountries: projectSettings.targetCountries,
  updatedAt: projectSettings.updatedAt,
}

export type ProjectSettingsRow = {
  projectId: ProjectId
  outboundMode: typeof OUTBOUND_MODES[number]
  senderEmailAlias: string | null
  senderDisplayName: string | null
  senderCompanyName: string | null
  senderJobTitle: string | null
  unsubscribeEnabled: boolean
  inquiryLandingEnabled: boolean
  inquiryChatBrief: string | null
  inquiryOneLiner: string | null
  inquiryVideoUrl: string | null
  inquiryPdfUrl: string | null
  inquiryBrandColor: string | null
  inquiryBrandLogoUrl: string | null
  inquiryCtaType: InquiryCtaType
  inquiryCtaUrl: string | null
  maxReapproachCycles: number
  unspecifiedRecontactWindowMonths: number
  noResponseRecycleDays: number
  outboundChannels: OutboundChannel[]
  targetCountries: string[]
  updatedAt: Date | null
}

export async function getOutboundMode(
  db: Db,
  projectId: ProjectId,
): Promise<OutboundMode> {
  const [row] = await db
    .select({ outboundMode: projectSettings.outboundMode })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  return assertSettingsRow(row, projectId).outboundMode
}

export type ProjectSendSettings = {
  outboundMode: OutboundMode
  senderEmailAlias: string | null
  senderDisplayName: string | null
  unsubscribeEnabled: boolean
  inquiryLandingEnabled: boolean
}

export async function loadProjectSendSettings(
  db: Db,
  projectId: ProjectId,
): Promise<ProjectSendSettings> {
  const [row] = await db
    .select({
      outboundMode: projectSettings.outboundMode,
      senderEmailAlias: projectSettings.senderEmailAlias,
      senderDisplayName: projectSettings.senderDisplayName,
      unsubscribeEnabled: projectSettings.unsubscribeEnabled,
      inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  return assertSettingsRow(row, projectId)
}

export type ProjectReapproachSettings = {
  maxReapproachCycles: number
  unspecifiedRecontactWindowMonths: number
  noResponseRecycleDays: number
}

export async function loadProjectReapproachSettings(
  db: Db,
  projectId: ProjectId,
): Promise<ProjectReapproachSettings> {
  const [row] = await db
    .select({
      maxReapproachCycles: projectSettings.maxReapproachCycles,
      unspecifiedRecontactWindowMonths: projectSettings.unspecifiedRecontactWindowMonths,
      noResponseRecycleDays: projectSettings.noResponseRecycleDays,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  return assertSettingsRow(row, projectId)
}

// Scoped to automated outbound; manual per-draft Send / Mark-sent bypass.
export type ProjectOutboundAllowlist = {
  outboundChannels: OutboundChannel[]
  targetCountries: string[]
}

export async function loadProjectOutboundAllowlist(
  db: Db,
  projectId: ProjectId,
): Promise<ProjectOutboundAllowlist> {
  const [row] = await db
    .select({
      outboundChannels: projectSettings.outboundChannels,
      targetCountries: projectSettings.targetCountries,
    })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  const r = assertSettingsRow(row, projectId)
  return {
    outboundChannels: r.outboundChannels as OutboundChannel[],
    targetCountries: r.targetCountries,
  }
}

export async function getProjectSettings(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
): Promise<ServiceResult<ProjectSettingsRow>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  const [row] = await db
    .select(settingsCols)
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  const r = assertSettingsRow(row, projectId)
  return ok({
    ...r,
    projectId: r.projectId as ProjectId,
    outboundChannels: r.outboundChannels as OutboundChannel[],
  })
}

export async function updateProjectSettings(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  patch: UpdateSettingsPatch,
): Promise<ServiceResult<ProjectSettingsRow>> {
  const guard = await requireProject(db, projectId, tenantId)
  if (!guard.ok) return guard

  // type='signup' requires a URL. The pre-load gives a friendly 400 in the
  // single-writer case; the atomic guarantee is chk_inquiry_cta_signup_requires_url
  // — concurrent partial PUTs can each pass this pre-check independently, and
  // only the constraint catches the merged result.
  if (patch.inquiryCtaType !== undefined || patch.inquiryCtaUrl !== undefined) {
    const [existing] = await db
      .select({
        inquiryCtaType: projectSettings.inquiryCtaType,
        inquiryCtaUrl: projectSettings.inquiryCtaUrl,
      })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1)
    const e = assertSettingsRow(existing, projectId)
    const nextType = patch.inquiryCtaType ?? e.inquiryCtaType
    const nextUrl = patch.inquiryCtaUrl !== undefined ? patch.inquiryCtaUrl : e.inquiryCtaUrl
    if (nextType === 'signup' && nextUrl === null) {
      return err('INVALID_INPUT', 'inquiryCtaUrl is required when inquiryCtaType is "signup"')
    }
  }

  const now = new Date()

  const updateSet = {
    ...(patch.outboundMode !== undefined ? { outboundMode: patch.outboundMode } : {}),
    ...(patch.senderEmailAlias !== undefined ? { senderEmailAlias: patch.senderEmailAlias } : {}),
    ...(patch.senderDisplayName !== undefined ? { senderDisplayName: patch.senderDisplayName } : {}),
    ...(patch.senderCompanyName !== undefined ? { senderCompanyName: patch.senderCompanyName } : {}),
    ...(patch.senderJobTitle !== undefined ? { senderJobTitle: patch.senderJobTitle } : {}),
    ...(patch.unsubscribeEnabled !== undefined ? { unsubscribeEnabled: patch.unsubscribeEnabled } : {}),
    ...(patch.inquiryLandingEnabled !== undefined ? { inquiryLandingEnabled: patch.inquiryLandingEnabled } : {}),
    ...(patch.inquiryChatBrief !== undefined ? { inquiryChatBrief: patch.inquiryChatBrief } : {}),
    ...(patch.inquiryOneLiner !== undefined ? { inquiryOneLiner: patch.inquiryOneLiner } : {}),
    ...(patch.inquiryVideoUrl !== undefined ? { inquiryVideoUrl: patch.inquiryVideoUrl } : {}),
    ...(patch.inquiryPdfUrl !== undefined ? { inquiryPdfUrl: patch.inquiryPdfUrl } : {}),
    ...(patch.inquiryBrandColor !== undefined ? { inquiryBrandColor: patch.inquiryBrandColor } : {}),
    ...(patch.inquiryBrandLogoUrl !== undefined ? { inquiryBrandLogoUrl: patch.inquiryBrandLogoUrl } : {}),
    ...(patch.inquiryCtaType !== undefined ? { inquiryCtaType: patch.inquiryCtaType } : {}),
    ...(patch.inquiryCtaUrl !== undefined ? { inquiryCtaUrl: patch.inquiryCtaUrl } : {}),
    ...(patch.maxReapproachCycles !== undefined ? { maxReapproachCycles: patch.maxReapproachCycles } : {}),
    ...(patch.unspecifiedRecontactWindowMonths !== undefined ? { unspecifiedRecontactWindowMonths: patch.unspecifiedRecontactWindowMonths } : {}),
    ...(patch.noResponseRecycleDays !== undefined ? { noResponseRecycleDays: patch.noResponseRecycleDays } : {}),
    ...(patch.outboundChannels !== undefined ? { outboundChannels: patch.outboundChannels } : {}),
    ...(patch.targetCountries !== undefined ? { targetCountries: patch.targetCountries } : {}),
    updatedAt: now,
  }

  const [row] = await db
    .update(projectSettings)
    .set(updateSet)
    .where(eq(projectSettings.projectId, projectId))
    .returning(settingsCols)

  const r = assertSettingsRow(row, projectId)
  return ok({
    ...r,
    projectId: r.projectId as ProjectId,
    outboundChannels: r.outboundChannels as OutboundChannel[],
  })
}
