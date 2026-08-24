import { z } from 'zod'
import { and, eq, isNotNull } from 'drizzle-orm'
import {
  projectSettings,
  projectProspects,
  sendingIdentities,
  OUTBOUND_MODES,
  OUTBOUND_CHANNELS,
  INQUIRY_CTA_TYPES,
  type OutboundMode,
  type OutboundChannel,
  type InquiryCtaType,
} from '../db/schema'
import type { Db } from '../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import { sendingIdentityIdSchema } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { isHttpsUrl, HTTPS_ONLY_MSG } from '../domain/url'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'
import { composeFooterBlock, replyUnsubscribeFooterLine } from '../domain/inquiry-footer'
import { localeSchema, type Locale } from '../domain/locale'
import { loadTenantSettings, localizeComplianceIdentity } from './tenants'
import { leverConfigSchema, leverConfigPatchSchema, leverConfigInvariantViolation, type LeverConfig } from '../domain/lever-config'
import {
  followUpSequenceSchema,
  followUpSequencePatchSchema,
  type FollowUpSequence,
} from '../domain/follow-up-sequence'

// 3-digit shorthand and named colors rejected so the frontend swatch / preview is deterministic.
const BRAND_COLOR_REGEX = /^#[0-9A-Fa-f]{6}$/

export const updateSettingsSchema = z
  .object({
    outboundMode: z.enum(OUTBOUND_MODES).optional(),
    // null falls back to the tenant's connected Gmail.
    sendingIdentityId: sendingIdentityIdSchema.nullable().optional(),
    senderEmailAlias: z.email().nullable().optional(),
    senderDisplayName: z.string().min(1).max(200).nullable().optional(),
    senderCompanyName: z.string().min(1).max(200).nullable().optional(),
    senderJobTitle: z.string().min(1).max(200).nullable().optional(),
    unsubscribeEnabled: z.boolean().optional(),
    footerOverride: z.string().trim().min(1).max(2000).nullable().optional(),
    inquiryLandingEnabled: z.boolean().optional(),
    inquiryChatBrief: z.string().max(4000).nullable().optional(),
    inquiryOneLiner: z.string().max(140).nullable().optional(),
    inquiryVideoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryPdfUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryBrandColor: z.string().regex(BRAND_COLOR_REGEX).nullable().optional(),
    inquiryBrandLogoUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    inquiryDarkBackground: z.boolean().optional(),
    inquiryCtaType: z.enum(INQUIRY_CTA_TYPES).optional(),
    inquiryCtaUrl: z.url().max(500).refine(isHttpsUrl, HTTPS_ONLY_MSG).nullable().optional(),
    // Bounds keep the skill / SaaS UI from pathological values that would
    // either spam (low) or freeze pipelines (very high).
    maxReapproachCycles: z.coerce.number().int().min(1).max(10).optional(),
    unspecifiedRecontactWindowMonths: z.coerce.number().int().min(1).max(24).optional(),
    noResponseRecycleDays: z.coerce.number().int().min(7).max(365).optional(),
    outboundChannels: z.array(z.enum(OUTBOUND_CHANNELS)).optional(),
    targetCountries: z.array(z.enum(ALLOWED_SEND_COUNTRIES)).optional(),
    targetLanguage: localeSchema.optional(),
    // Overrides only: stored as the caller sent it (a partial), merged with the
    // defaults at read time by loadLeverConfig. Whole-cell replace (not deep-merged)
    // — a PUT must carry the full set of overrides it wants; an unset field then
    // tracks the live leverConfigSchema default.
    leverConfig: leverConfigPatchSchema.optional(),
    // Overrides only, whole-cell replace (like leverConfig). enabled:false also
    // clears in-progress sequences (kill-switch — see updateProjectSettings).
    followUpSequence: followUpSequencePatchSchema.optional(),
  })
  .strict()
export type UpdateSettingsPatch = z.infer<typeof updateSettingsSchema>

// Fields that bound what the agent may do — which mailbox and name it sends
// as, whether sends wait for human review, what the footer discloses, what
// the recipient-facing landing shows and where it sends them. Web UI only;
// the agent proposes in chat.
const UI_ONLY_SETTINGS = [
  'outboundMode',
  'sendingIdentityId',
  'senderEmailAlias',
  'senderDisplayName',
  'senderCompanyName',
  'senderJobTitle',
  'footerOverride',
  'inquiryVideoUrl',
  'inquiryPdfUrl',
  'inquiryBrandColor',
  'inquiryBrandLogoUrl',
  'inquiryDarkBackground',
  'inquiryCtaType',
  'inquiryCtaUrl',
] as const satisfies readonly (keyof UpdateSettingsPatch)[]

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
  sendingIdentityId: projectSettings.sendingIdentityId,
  senderEmailAlias: projectSettings.senderEmailAlias,
  senderDisplayName: projectSettings.senderDisplayName,
  senderCompanyName: projectSettings.senderCompanyName,
  senderJobTitle: projectSettings.senderJobTitle,
  unsubscribeEnabled: projectSettings.unsubscribeEnabled,
  footerOverride: projectSettings.footerOverride,
  inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
  inquiryChatBrief: projectSettings.inquiryChatBrief,
  inquiryOneLiner: projectSettings.inquiryOneLiner,
  inquiryVideoUrl: projectSettings.inquiryVideoUrl,
  inquiryPdfUrl: projectSettings.inquiryPdfUrl,
  inquiryBrandColor: projectSettings.inquiryBrandColor,
  inquiryBrandLogoUrl: projectSettings.inquiryBrandLogoUrl,
  inquiryDarkBackground: projectSettings.inquiryDarkBackground,
  inquiryCtaType: projectSettings.inquiryCtaType,
  inquiryCtaUrl: projectSettings.inquiryCtaUrl,
  maxReapproachCycles: projectSettings.maxReapproachCycles,
  unspecifiedRecontactWindowMonths: projectSettings.unspecifiedRecontactWindowMonths,
  noResponseRecycleDays: projectSettings.noResponseRecycleDays,
  followUpSequence: projectSettings.followUpSequence,
  outboundChannels: projectSettings.outboundChannels,
  targetCountries: projectSettings.targetCountries,
  targetLanguage: projectSettings.targetLanguage,
  updatedAt: projectSettings.updatedAt,
}

export type ProjectSettingsRow = {
  projectId: ProjectId
  outboundMode: typeof OUTBOUND_MODES[number]
  sendingIdentityId: string | null
  senderEmailAlias: string | null
  senderDisplayName: string | null
  senderCompanyName: string | null
  senderJobTitle: string | null
  unsubscribeEnabled: boolean
  footerOverride: string | null
  // Not a column — the default footer resolved at read (resolveFooterDefault).
  footerDefault: string | null
  inquiryLandingEnabled: boolean
  inquiryChatBrief: string | null
  inquiryOneLiner: string | null
  inquiryVideoUrl: string | null
  inquiryPdfUrl: string | null
  inquiryBrandColor: string | null
  inquiryBrandLogoUrl: string | null
  inquiryDarkBackground: boolean
  inquiryCtaType: InquiryCtaType
  inquiryCtaUrl: string | null
  maxReapproachCycles: number
  unspecifiedRecontactWindowMonths: number
  noResponseRecycleDays: number
  followUpSequence: FollowUpSequence
  outboundChannels: OutboundChannel[]
  targetCountries: string[]
  targetLanguage: Locale
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
  footerOverride: string | null
  inquiryLandingEnabled: boolean
  inquiryCtaType: InquiryCtaType
  inquiryCtaUrl: string | null
  targetLanguage: Locale
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
      footerOverride: projectSettings.footerOverride,
      inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
      inquiryCtaType: projectSettings.inquiryCtaType,
      inquiryCtaUrl: projectSettings.inquiryCtaUrl,
      targetLanguage: projectSettings.targetLanguage,
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

export async function loadLeverConfig(db: Db, projectId: ProjectId): Promise<LeverConfig> {
  const [row] = await db
    .select({ leverConfig: projectSettings.leverConfig })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  return leverConfigSchema.parse(assertSettingsRow(row, projectId).leverConfig)
}

export async function loadProjectFollowUpConfig(
  db: Db,
  projectId: ProjectId,
): Promise<FollowUpSequence> {
  const [row] = await db
    .select({ followUpSequence: projectSettings.followUpSequence })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  return followUpSequenceSchema.parse(assertSettingsRow(row, projectId).followUpSequence)
}

// Same locale input as the send path so the preview can't drift; opt-out
// wording rotates per prospect at send, fixed seed here. null until
// workspace legalName / physicalAddress are set.
async function resolveFooterDefault(
  db: Db,
  tenantId: TenantId,
  locale: Locale,
): Promise<ServiceResult<string | null>> {
  const settings = await loadTenantSettings(db, tenantId)
  if (!settings.ok) return settings
  const t = settings.value
  if (!t.legalName || !t.physicalAddress) return ok(null)
  const identity = localizeComplianceIdentity(
    {
      legalName: t.legalName,
      physicalAddress: t.physicalAddress,
      legalNameJa: t.legalNameJa,
      physicalAddressJa: t.physicalAddressJa,
    },
    locale,
  )
  return ok(
    composeFooterBlock([
      identity.legalName,
      identity.physicalAddress,
      replyUnsubscribeFooterLine(locale, 0),
    ]),
  )
}

export async function getProjectSettings(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<ProjectSettingsRow>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [row] = await db
    .select(settingsCols)
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1)
  const r = assertSettingsRow(row, projectId)
  const footerDefault = await resolveFooterDefault(db, tenantId, r.targetLanguage)
  if (!footerDefault.ok) return footerDefault
  return ok({
    ...r,
    projectId: r.projectId as ProjectId,
    footerDefault: footerDefault.value,
    outboundChannels: r.outboundChannels as OutboundChannel[],
    followUpSequence: followUpSequenceSchema.parse(r.followUpSequence),
  })
}

export async function updateProjectSettings(
  db: Db,
  tenantId: TenantId,
  caller: 'browser' | 'mcp',
  projectRef: ProjectRef,
  patch: UpdateSettingsPatch,
): Promise<ServiceResult<ProjectSettingsRow>> {
  if (caller === 'mcp') {
    const blocked = UI_ONLY_SETTINGS.filter((k) => patch[k] !== undefined)
    if (blocked.length > 0) {
      return err('FORBIDDEN', `${blocked.join(', ')}: set from the Web UI (Project / Inquiry settings) only`)
    }
  }
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

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

  // Friendly 400 in the single-writer case; chk_footer_override_inquiry_off is
  // the atomic guarantee (same race caveat as the CTA pre-check above).
  if (patch.footerOverride !== undefined || patch.inquiryLandingEnabled !== undefined) {
    const [existing] = await db
      .select({
        inquiryLandingEnabled: projectSettings.inquiryLandingEnabled,
        footerOverride: projectSettings.footerOverride,
      })
      .from(projectSettings)
      .where(eq(projectSettings.projectId, projectId))
      .limit(1)
    const e = assertSettingsRow(existing, projectId)
    const nextEnabled = patch.inquiryLandingEnabled ?? e.inquiryLandingEnabled
    const nextOverride = patch.footerOverride !== undefined ? patch.footerOverride : e.footerOverride
    if (nextEnabled && nextOverride !== null) {
      return err(
        'INVALID_INPUT',
        'A custom footer and the inquiry landing are mutually exclusive',
        'The inquiry landing appends a per-prospect link the static footer cannot carry. Reset the footer to default to enable the inquiry landing, or disable the inquiry landing to customize the footer.',
      )
    }
  }

  // leverConfig is whole-cell replace, so defaults + this patch IS the future
  // effective config — cross-field invariants are checkable at the write.
  if (patch.leverConfig !== undefined) {
    const violation = leverConfigInvariantViolation(leverConfigSchema.parse(patch.leverConfig))
    if (violation) return err('INVALID_INPUT', 'Invalid lever config', violation)
  }

  // FK is the atomic guarantee; this pre-check turns the common case into a clean 400.
  if (patch.sendingIdentityId != null) {
    const [identity] = await db
      .select({ id: sendingIdentities.identityId })
      .from(sendingIdentities)
      .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, patch.sendingIdentityId)))
      .limit(1)
    if (!identity) {
      return err('INVALID_INPUT', 'Unknown sending identity', `No sending identity ${patch.sendingIdentityId} for this tenant.`)
    }
  }

  const now = new Date()

  const updateSet = {
    ...(patch.outboundMode !== undefined ? { outboundMode: patch.outboundMode } : {}),
    ...(patch.sendingIdentityId !== undefined ? { sendingIdentityId: patch.sendingIdentityId } : {}),
    ...(patch.senderEmailAlias !== undefined ? { senderEmailAlias: patch.senderEmailAlias } : {}),
    ...(patch.senderDisplayName !== undefined ? { senderDisplayName: patch.senderDisplayName } : {}),
    ...(patch.senderCompanyName !== undefined ? { senderCompanyName: patch.senderCompanyName } : {}),
    ...(patch.senderJobTitle !== undefined ? { senderJobTitle: patch.senderJobTitle } : {}),
    ...(patch.unsubscribeEnabled !== undefined ? { unsubscribeEnabled: patch.unsubscribeEnabled } : {}),
    ...(patch.footerOverride !== undefined ? { footerOverride: patch.footerOverride } : {}),
    ...(patch.inquiryLandingEnabled !== undefined ? { inquiryLandingEnabled: patch.inquiryLandingEnabled } : {}),
    ...(patch.inquiryChatBrief !== undefined ? { inquiryChatBrief: patch.inquiryChatBrief } : {}),
    ...(patch.inquiryOneLiner !== undefined ? { inquiryOneLiner: patch.inquiryOneLiner } : {}),
    ...(patch.inquiryVideoUrl !== undefined ? { inquiryVideoUrl: patch.inquiryVideoUrl } : {}),
    ...(patch.inquiryPdfUrl !== undefined ? { inquiryPdfUrl: patch.inquiryPdfUrl } : {}),
    ...(patch.inquiryBrandColor !== undefined ? { inquiryBrandColor: patch.inquiryBrandColor } : {}),
    ...(patch.inquiryBrandLogoUrl !== undefined ? { inquiryBrandLogoUrl: patch.inquiryBrandLogoUrl } : {}),
    ...(patch.inquiryDarkBackground !== undefined ? { inquiryDarkBackground: patch.inquiryDarkBackground } : {}),
    ...(patch.inquiryCtaType !== undefined ? { inquiryCtaType: patch.inquiryCtaType } : {}),
    ...(patch.inquiryCtaUrl !== undefined ? { inquiryCtaUrl: patch.inquiryCtaUrl } : {}),
    ...(patch.maxReapproachCycles !== undefined ? { maxReapproachCycles: patch.maxReapproachCycles } : {}),
    ...(patch.unspecifiedRecontactWindowMonths !== undefined ? { unspecifiedRecontactWindowMonths: patch.unspecifiedRecontactWindowMonths } : {}),
    ...(patch.noResponseRecycleDays !== undefined ? { noResponseRecycleDays: patch.noResponseRecycleDays } : {}),
    ...(patch.outboundChannels !== undefined ? { outboundChannels: patch.outboundChannels } : {}),
    ...(patch.targetCountries !== undefined ? { targetCountries: patch.targetCountries } : {}),
    ...(patch.targetLanguage !== undefined ? { targetLanguage: patch.targetLanguage } : {}),
    ...(patch.leverConfig !== undefined ? { leverConfig: patch.leverConfig } : {}),
    ...(patch.followUpSequence !== undefined ? { followUpSequence: patch.followUpSequence } : {}),
    updatedAt: now,
  }

  const [row] = await db
    .update(projectSettings)
    .set(updateSet)
    .where(eq(projectSettings.projectId, projectId))
    .returning(settingsCols)

  // Kill-switch: clear in-progress sequences so the follow-up arm stops re-picking
  // them. Keyed on the EFFECTIVE enabled after the whole-cell replace (a cadence-
  // only patch omitting `enabled` reads back disabled and must clear too), not an
  // explicit false.
  if (
    patch.followUpSequence !== undefined &&
    !followUpSequenceSchema.parse(patch.followUpSequence).enabled
  ) {
    await db
      .update(projectProspects)
      .set({ nextFollowupAfter: null, updatedAt: now })
      .where(and(
        eq(projectProspects.projectId, projectId),
        isNotNull(projectProspects.nextFollowupAfter),
      ))
  }

  const r = assertSettingsRow(row, projectId)
  const footerDefault = await resolveFooterDefault(db, tenantId, r.targetLanguage)
  if (!footerDefault.ok) return footerDefault
  return ok({
    ...r,
    projectId: r.projectId as ProjectId,
    footerDefault: footerDefault.value,
    outboundChannels: r.outboundChannels as OutboundChannel[],
    followUpSequence: followUpSequenceSchema.parse(r.followUpSequence),
  })
}
