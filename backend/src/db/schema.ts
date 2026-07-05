import { z } from 'zod'
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { LeverConfigPatch } from '../domain/lever-config'
import type { FollowUpSequencePatch } from '../domain/follow-up-sequence'
import type { ChannelAffinityMap, ChannelCoarseStat } from '../domain/channel-affinity'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType() {
    return 'bytea'
  },
})

export const prospectStatusEnum = pgEnum('prospect_status', [
  'new',
  'contacted',
  'responded',
  'converted',
  'rejected',
  'inactive',
  'deferred',
])

export type ProspectStatus = (typeof prospectStatusEnum.enumValues)[number]

// Statuses that are eligible to be sent outreach: never-contacted plus
// time-deferred prospects whose recontact window has passed (the latter is
// gated additionally by prospects.next_outreach_after at query time).
export const REACHABLE_STATUSES: readonly ProspectStatus[] = ['new', 'deferred']

// `project_prospects.priority` is constrained to 1-5 by chk_priority. Drizzle
// types the column as `number`; the Zod schema narrows external input to
// `Priority` at the boundary, so insert/update sites pass `Priority` (a
// subtype of `number`) without an `as` cast.
export type Priority = 1 | 2 | 3 | 4 | 5
export const prioritySchema = z.literal([1, 2, 3, 4, 5])
export const priorityCoerceSchema = z.coerce.number().pipe(prioritySchema)

export const channelEnum = pgEnum('channel', [
  'email',
  'form',
  'sns_twitter',
  'sns_linkedin',
])

export type Channel = (typeof channelEnum.enumValues)[number]

// 'pre_send' is the optimistic-allocation state for skill-driven channels
// (form / SNS DM): the row is reserved BEFORE the skill submits so that an
// inquiry-landing token can be FK-bound to it, but the prospect is NOT yet
// flipped to 'contacted' and quota is reserved (counted toward used) but
// only confirmed-spent on the 'sent' transition. The skill calls
// updateOutreachStatus('sent') on submit success or ('failed') on submit
// failure. A 'pre_send' row that never resolves is treated as in-flight by
// listReachable (NOT EXISTS) and counts against quota until cleared.
// 'skipped' records an outbound run's deliberate decision NOT to contact a
// prospect (no send attempted) so the audit trail and the recycle-window
// stamp survive without faking a 'failed' row. Quota counts 'sent' only and
// cycle.n counts 'sent' only, so a skip consumes neither; it surfaces in the
// recent-outreach feed and the org-detail history, carrying skip_reason.
export const outreachStatusEnum = pgEnum('outreach_status', ['sent', 'failed', 'pending_review', 'pre_send', 'skipped'])
export type OutreachStatus = (typeof outreachStatusEnum.enumValues)[number]

// Structured reason a 'skipped' row was written. 'bad_timing' /
// 'no_fresh_material' are LLM judgments the server cannot make on its own
// (the deterministic country gate filters candidates server-side, so it is
// not a skip reason); 'other' is the escape hatch. NULL on every non-skip row.
export const skipReasonEnum = pgEnum('skip_reason', ['bad_timing', 'no_fresh_material', 'other'])
export type SkipReason = (typeof skipReasonEnum.enumValues)[number]

// Statuses that represent allocated-but-not-yet-confirmed outreach: the row
// exists in outreach_logs but the channel has neither delivered nor failed.
// Readers that surface "real outreach activity" (recent feed) and
// "candidates to contact" (listReachable NOT EXISTS) treat both members the
// same. Typed as readonly OutreachStatus[] (not `as const` tuple) so it can
// be passed directly to drizzle's inArray / notInArray — same pattern as
// REACHABLE_STATUSES above.
export const IN_FLIGHT_OUTREACH_STATUSES: readonly OutreachStatus[] = ['pending_review', 'pre_send']

// Self-cleanup TTL for pre_send rows. If the skill / Chrome MCP crashes
// between recordOutreachWithInquiry and updateOutreachStatus, the pre_send
// row would otherwise hold quota and exclude the prospect from listReachable
// forever. After this window we stop counting the row toward both — the row
// itself is left in place (audit trail) but treated as abandoned. Tuned at
// the high end of realistic form-fill / SNS-compose time + margin.
export const PRE_SEND_TTL_MINUTES = 30

export const sentimentEnum = pgEnum('sentiment', ['positive', 'neutral', 'negative'])

export const responseTypeEnum = pgEnum('response_type', [
  'reply',
  'auto_reply',
  'bounce',
  'meeting_request',
  'rejection',
])

export const formTypeEnum = pgEnum('form_type', [
  'google_forms',
  'native_html',
  'wordpress_cf7',
  'iframe_embed',
  'with_captcha',
])

export const planEnum = pgEnum('plan', ['free', 'starter', 'pro', 'scale', 'unlimited'])

export const tenantRoleEnum = pgEnum('tenant_role', ['owner', 'admin', 'member'])

// Trust ranking for country values: manual is authoritative; tld_inferred is
// deterministic but coarse; ai_inferred is best-effort.
export const COUNTRY_SOURCES = ['tld_inferred', 'manual', 'ai_inferred'] as const
export type CountrySource = (typeof COUNTRY_SOURCES)[number]
export const countrySourceEnum = pgEnum('country_source', COUNTRY_SOURCES)

export const OUTBOUND_MODES = ['send', 'draft'] as const
export type OutboundMode = (typeof OUTBOUND_MODES)[number]
export const outboundModeEnum = pgEnum('outbound_mode', OUTBOUND_MODES)

// Mirrors channelEnum; stored as text[] in project_settings, no DB enum.
export const OUTBOUND_CHANNELS = ['email', 'form', 'sns_twitter', 'sns_linkedin'] as const
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number]

// Outcome semantics and the responses-row write rules: design §6.3.
// 'signup_clicked' is the self-serve counterpart to 'lead' — landing CTA
// configured as 'signup' redirects to a SaaS signup page instead of a
// meeting request, so the visitor never enters human-sales follow-up.
export const INQUIRY_OUTCOMES = ['opened', 'inquired', 'lead', 'signup_clicked', 'unsubscribed'] as const
export type InquiryOutcome = (typeof INQUIRY_OUTCOMES)[number]
export const inquiryOutcomeEnum = pgEnum('inquiry_outcome', INQUIRY_OUTCOMES)

// Inquiry landing CTA mode — selects which call-to-action the landing
// page renders. 'meeting' is the human-sales path (Book a meeting /
// Request a meeting); 'signup' is the self-serve path (Sign up button
// linking to inquiryCtaUrl). The two modes are mutually exclusive per
// project — landing renders one CTA, never both.
export const INQUIRY_CTA_TYPES = ['meeting', 'signup'] as const
export type InquiryCtaType = (typeof INQUIRY_CTA_TYPES)[number]
export const inquiryCtaTypeEnum = pgEnum('inquiry_cta_type', INQUIRY_CTA_TYPES)

export const INQUIRY_MESSAGE_ROLES = ['user', 'assistant'] as const
export type InquiryMessageRole = (typeof INQUIRY_MESSAGE_ROLES)[number]
export const inquiryMessageRoleEnum = pgEnum('inquiry_message_role', INQUIRY_MESSAGE_ROLES)

// NULL unless outcome='lead'; distinguishes button-click from AI-derived leads.
export const MEETING_REQUEST_SOURCES = ['button', 'chat'] as const
export type MeetingRequestSource = (typeof MEETING_REQUEST_SOURCES)[number]
export const meetingRequestSourceEnum = pgEnum('meeting_request_source', MEETING_REQUEST_SOURCES)

// Per-session frozen context for inquiry chat. Synthesized once at session
// open from project_settings.inquiry_chat_brief + prospects.hypothesis +
// orgSignalsGlobal.signals; subsequent chat turns read this snapshot
// verbatim so the LLM context stays stable across the conversation.
export type InquirySessionContextSnapshot = {
  brief: string
  prospectHints?: {
    contactName?: string
    organizationName?: string
    hypothesizedPain?: string[]
    timingSignals?: string[]
  }
  // Freshest input that fed into `brief` — surfaced for future snapshot
  // invalidation (not currently used).
  sourceUpdatedAt: string
}

export type SnsAccounts = {
  x?: string
  linkedin?: string
  instagram?: string
  facebook?: string
}

// Generated by /build-list at registration and frozen afterwards.
// bestChannel/bestKeyperson are surfaced to /outbound as a channel/addressing
// hint; the full hypothesis feeds the inquiry-chat brief. Fields are all
// optional — a partially filled hypothesis is still useful (the LLM
// gracefully degrades).
export type ProspectHypothesis = {
  targetDepartment?: string
  targetRolePattern?: string
  hypothesizedPain?: string[]
  valueMapping?: string[]
  timingSignals?: string[]
  bestChannel?: string
  bestKeyperson?: string
}

export const REJECTION_PRIMARY_REASONS = [
  'not_relevant',
  'wrong_timing',
  'budget',
  'feature_gap',
  'already_have_solution',
  'competitor_locked',
  'not_decision_maker',
  'unsubscribe_request',
  'other',
] as const

export const REJECTION_RECONTACT_WINDOWS = [
  'never',
  '3_months',
  '6_months',
  '12_months',
  'unspecified',
] as const

export type RejectionPrimaryReason = (typeof REJECTION_PRIMARY_REASONS)[number]
export type RejectionRecontactWindow = (typeof REJECTION_RECONTACT_WINDOWS)[number]

// Wire format mirrors landing/public/schema/rejection-feedback-v1.json.
// Keep field names snake_case to match the published JSON Schema URI.
export type RejectionFeedbackV1 = {
  version: 1
  primary_reason: RejectionPrimaryReason
  secondary_reasons?: RejectionPrimaryReason[]
  free_text?: string
  decision_maker_pointer?: { name?: string; email?: string; role?: string }
  preferred_recontact_window?: RejectionRecontactWindow
  consent?: {
    gdpr_erasure_request?: boolean
    ccpa_opt_out?: boolean
    marketing_opt_out?: boolean
  }
  submitted_at: string
  tenant_signature?: string
}

export type EvaluationMetrics = {
  totalOutreach: number
  channelCounts: Array<{ channel: string; count: number }>
  responseCounts: { totalResponses: number; uniqueResponders: number }
  sentimentBreakdown: Array<{ sentiment: string; responseType: string; count: number }>
  priorityResponseRate: Array<{
    priority: number
    total: number
    responses: number
    rate: number
  }>
  statusCounts: Array<{ status: string; count: number }>
  channelResponseRate: Array<{
    channel: string
    total: number
    responses: number
    rate: number
  }>
  channelByIndustry: Array<{
    channel: string
    industry: string | null
    total: number
    responses: number
    rate: number
  }>
  // Read-only foundation for the subject bandit (charter P0); nothing selects on it yet.
  variantResponseRate: Array<{
    variantId: string
    total: number
    responses: number
    rate: number
    meanReward: number
  }>
  // strategy=null bucket = sends to prospects without recorded provenance.
  discoveryStrategyResponseRate: Array<{
    strategy: string | null
    total: number
    responses: number
    rate: number
  }>
  freshSignalResponseRate: {
    withSignal: { total: number; responses: number; rate: number }
    withoutSignal: { total: number; responses: number; rate: number }
  }
  // Inquiry-landing outcomes per project. Captures self-serve conversions
  // ('signup_clicked') and chat-only engagement ('inquired') that the
  // response-axis metrics above miss — responses are written for
  // meeting_request / unsubscribe but not for chat-only or signup-CTA paths.
  inquiryOutcomeCounts: Record<InquiryOutcome, number>
}

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull().default('My Workspace'),
  // Compliance-mandated tenant identity (CAN-SPAM / CASL footer, CASL §6
  // sender identification). Nullable at the DB level because tenants are
  // auto-provisioned on first API access and the user fills these in via
  // the Tenant Settings UI; backend send paths gate on
  // assertTenantComplianceReady before any actual outreach.
  legalName: text('legal_name'),
  physicalAddress: text('physical_address'),
  // ISO 3166-1 alpha-2 (e.g. 'US'). The tenant's own country, used for
  // future jurisdiction-specific footer rendering and per-country audit. Not
  // the recipient's country (that lives on prospects / organizations).
  defaultSenderCountry: text('default_sender_country'),
  // Japanese footer variants, used verbatim for JP recipients (effective
  // country = JP) so a bilingual sender shows its Japanese legal identity to
  // Japanese customers and the English one to everyone else. Null = no JA
  // variant; the footer falls back to the columns above. Optional — never
  // gates a send (the *_ja columns are not part of compliance readiness).
  legalNameJa: text('legal_name_ja'),
  physicalAddressJa: text('physical_address_ja'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // NULL = the plugin has never connected; gates the web onboarding flow.
  firstMcpConnectedAt: timestamp('first_mcp_connected_at', { withTimezone: true }),
})

export const tenantMembers = pgTable('tenant_members', {
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull(),
  role: tenantRoleEnum('role').notNull().default('owner'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.userId] }),
  // 1 user = 1 tenant (current product design). DB-enforced to prevent race conditions
  // in auth middleware auto-provisioning. Remove if/when teams (many users → 1 tenant) ship.
  unique('uq_tenant_members_user').on(table.userId),
  index('idx_tenant_members_user').on(table.userId),
])

export const sendingIdentityProviderEnum = pgEnum('sending_identity_provider', ['gmail_oauth', 'smtp_imap'])
export type SendingIdentityProvider = (typeof sendingIdentityProviderEnum.enumValues)[number]

// `secret` is pgp_sym_encrypt'd at write; the DB only ever sees the encrypted bytea.
export const sendingIdentities = pgTable('sending_identities', {
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  identityId: text('identity_id').notNull(),
  userId: text('user_id').notNull(),
  provider: sendingIdentityProviderEnum('provider').notNull(),
  fromEmail: text('from_email').notNull(),
  // Granted OAuth scopes — gmail_oauth only; NULL for smtp_imap (no OAuth concept).
  scope: text('scope'),
  secret: bytea('secret').notNull(),
  warmupStartedAt: timestamp('warmup_started_at', { withTimezone: true }),
  dailyCapOverride: integer('daily_cap_override'),
  pausedUntil: timestamp('paused_until', { withTimezone: true }),
  // Observability only — NOT a poll cursor (the poll re-searches a fixed window).
  lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.identityId] }),
  // One gmail_oauth per user (backs the reconnect upsert); partial so a tenant can
  // hold several smtp_imap identities.
  uniqueIndex('uq_sending_identities_gmail_per_user')
    .on(table.tenantId, table.userId)
    .where(sql`${table.provider} = 'gmail_oauth'`),
  // No two identities share a From address within a tenant.
  unique('uq_sending_identities_tenant_from_email').on(table.tenantId, table.fromEmail),
  index('idx_sending_identities_tenant_provider').on(table.tenantId, table.provider),
])

export const tenantPlans = pgTable('tenant_plans', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  plan: planEnum('plan').notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_project_tenant_name').on(table.tenantId, table.name),
  // Required so project_prospects / outreach_logs etc. can declare composite
  // (project_id, tenant_id) foreign keys that prevent cross-tenant references
  // at write time (defense-in-depth on top of RLS).
  unique('uq_project_id_tenant').on(table.id, table.tenantId),
  index('idx_projects_tenant').on(table.tenantId),
])

export const projectSettings = pgTable('project_settings', {
  projectId: text('project_id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  outboundMode: outboundModeEnum('outbound_mode').notNull().default('send'),
  senderEmailAlias: text('sender_email_alias'),
  senderDisplayName: text('sender_display_name'),
  // Per-project sending identity; NULL falls back to the tenant's connected Gmail.
  sendingIdentityId: text('sending_identity_id'),
  // Recipient-facing company / brand name (e.g. "Acme Inc."). Paired with
  // senderDisplayName: the inquiry landing renders "From {senderDisplayName}
  // at {senderCompanyName}". NULL omits the "at ..." suffix. Distinct from
  // tenants.legalName (compliance footer) and tenants.name (internal
  // workspace label that is documented as never sent to recipients).
  senderCompanyName: text('sender_company_name'),
  // Optional job title shown on the inquiry landing header alongside
  // senderDisplayName / senderCompanyName: "From {name}, {role} at {company}".
  // NULL falls back to "From {name} at {company}".
  senderJobTitle: text('sender_job_title'),
  // Gates the RFC 8058 List-Unsubscribe(-Post) headers only. Off by default: the
  // header lands cold mail in Gmail's Promotions tab; the footer line carries the
  // legal opt-out on its own.
  unsubscribeEnabled: boolean('unsubscribe_enabled').notNull().default(false),
  // Format checks (URL shape, hex color) live in zod, not DB CHECK
  // constraints — those would be brittle for URL/hex evolution.
  // Default off: cold mail is link-free by default (a shared app-domain link is
  // the dominant spam trigger). Opt in per project to surface the inquiry link.
  inquiryLandingEnabled: boolean('inquiry_landing_enabled').notNull().default(false),
  // NULL disables the chat input but leaves the rest of the landing page
  // (video, PDF, meeting button, unsubscribe) rendering.
  inquiryChatBrief: text('inquiry_chat_brief'),
  inquiryOneLiner: text('inquiry_one_liner'),
  inquiryVideoUrl: text('inquiry_video_url'),
  inquiryPdfUrl: text('inquiry_pdf_url'),
  inquiryBrandColor: text('inquiry_brand_color'),
  inquiryBrandLogoUrl: text('inquiry_brand_logo_url'),
  // Landing background mode. false = light canvas (default), true = dark. The
  // brand color stays the accent on either; text/surface tokens follow the
  // mode for contrast. Rendered by toggling the `.dark` class on the inquiry
  // landing root, which re-scopes the CSS-var theme tokens.
  inquiryDarkBackground: boolean('inquiry_dark_background').notNull().default(false),
  // Landing CTA mode. 'meeting' renders Book/Request meeting (the
  // human-sales path); 'signup' renders a Sign up button that redirects
  // visitors to inquiryCtaUrl (the self-serve path, no human follow-up).
  // The two are mutually exclusive — chosen per project, never both.
  inquiryCtaType: inquiryCtaTypeEnum('inquiry_cta_type').notNull().default('meeting'),
  // External CTA URL. For 'meeting' mode this is an optional scheduling
  // URL (Calendly, TimeRex, etc.); when non-null the meeting button opens
  // it in a new tab and still records the lead, when null the button is
  // notify-only. For 'signup' mode this is the SaaS signup page URL and
  // is required (the route layer rejects 'signup' + null).
  inquiryCtaUrl: text('inquiry_cta_url'),
  // Hard cap on rejection cycles before forcing 'rejected' + DNC ratchet.
  maxReapproachCycles: smallint('max_reapproach_cycles').notNull().default(3),
  // Months to defer when rejection feedback's preferred_recontact_window is
  // 'unspecified' (no concrete date stated by the prospect).
  unspecifiedRecontactWindowMonths: smallint('unspecified_recontact_window_months').notNull().default(3),
  // Days after a 'sent' outreach to make the prospect re-eligible if no
  // response arrived. Stamped onto prospects.next_outreach_after via
  // GREATEST(existing, sentAt + days) — only advances the window forward,
  // never shortens an explicit longer window already in place (e.g. a
  // rejection-feedback '12_months' deferral).
  noResponseRecycleDays: smallint('no_response_recycle_days').notNull().default(90),
  // Overrides only ({} = none); loadLeverConfig fills the rest at read, so default changes need no backfill.
  leverConfig: jsonb('lever_config').$type<LeverConfigPatch>().notNull().default({}),
  // Day-scale follow-up sequence (P1); overrides only, filled at read. Existing
  // rows ({}) parse to enabled:false, so only new opted-in projects sequence.
  followUpSequence: jsonb('follow_up_sequence').$type<FollowUpSequencePatch>().notNull().default({}),
  // Scoped to automated outbound (listReachable). Empty array pauses
  // automated outbound; manual UI Send / Mark-sent bypass.
  outboundChannels: text('outbound_channels').array().notNull()
    .default(sql`'{"email","form","sns_twitter","sns_linkedin"}'`),
  // Further narrows ALLOWED_SEND_COUNTRIES for automated outbound; empty =
  // no project-level restriction. Send-time compliance gate is independent.
  targetCountries: text('target_countries').array().notNull().default(sql`'{}'`),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_project_settings_tenant').on(table.tenantId),
  // Composite FK ties project_id + tenant_id together so a settings row
  // cannot reference a project in a different tenant (defense-in-depth on
  // top of RLS). The single-column .references() is folded in here.
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_project_settings_project_tenant',
  }).onDelete('cascade'),
  // Same-tenant FK; NO ACTION blocks deleting an identity a project still points
  // at (deleteSendingIdentity pre-checks for a friendly conflict).
  foreignKey({
    columns: [table.tenantId, table.sendingIdentityId],
    foreignColumns: [sendingIdentities.tenantId, sendingIdentities.identityId],
    name: 'fk_project_settings_sending_identity',
  }),
  // signup mode is meaningless without a destination. The application-level
  // pre-check in updateProjectSettings races under concurrent partial PUTs
  // (one PUT flips type → 'signup', another nulls the URL — both pass their
  // own pre-check); this CHECK is the atomic guarantee.
  check(
    'chk_inquiry_cta_signup_requires_url',
    sql`${table.inquiryCtaType} <> 'signup' OR ${table.inquiryCtaUrl} IS NOT NULL`,
  ),
])

export const organizations = pgTable('organizations', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // Apex domain (e.g. "example.com"), not the full URL.
  domain: text('domain').notNull(),
  name: text('name').notNull(),
  websiteUrl: text('website_url').notNull(),
  // ISO 3166-1 alpha-2 (e.g. 'US'). Drives the send-time country guardrail.
  // NULL when not derivable (generic gTLD without an explicit caller hint);
  // null is treated as warn-only at send time. countrySource records how
  // the value was set so callers can decide how much to trust it.
  country: text('country'),
  countrySource: countrySourceEnum('country_source'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_org_tenant_domain').on(table.tenantId, table.domain),
  // Required so prospects can declare a composite (organization_id, tenant_id)
  // foreign key that prevents cross-tenant references at write time
  // (defense-in-depth on top of RLS).
  unique('uq_org_id_tenant').on(table.id, table.tenantId),
  index('idx_org_tenant').on(table.tenantId),
])

// The outbound email gate drops only 'undeliverable'; 'unknown' (the default for
// unverified or inconclusive rows) is accepted. Extend via ALTER TYPE ADD VALUE.
export const emailDeliverabilityEnum = pgEnum('email_deliverability', ['unknown', 'undeliverable'])
export type EmailDeliverability = (typeof emailDeliverabilityEnum.enumValues)[number]

export const prospects = pgTable('prospects', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  contactName: text('contact_name'),
  organizationId: integer('organization_id').notNull(),
  department: text('department'),
  overview: text('overview').notNull(),
  industry: text('industry'),
  websiteUrl: text('website_url').notNull(),
  email: text('email'),
  contactFormUrl: text('contact_form_url'),
  formType: formTypeEnum('form_type'),
  snsAccounts: jsonb('sns_accounts').$type<SnsAccounts>(),
  doNotContact: boolean('do_not_contact').notNull().default(false),
  notes: text('notes'),
  // When set in the future, get_outbound_targets skips this prospect until the
  // timestamp passes. Populated by record_response when a rejection carries a
  // preferred_recontact_window of 3/6/12 months.
  nextOutreachAfter: timestamp('next_outreach_after', { withTimezone: true }),
  // Per-prospect targeting hypothesis. /build-list seeds this from public
  // sources at registration; get_outbound_targets surfaces
  // bestChannel/bestKeyperson to /outbound, and inquiry-chat reads the rest.
  // NULL = not yet computed; the LLM falls back to overview alone.
  hypothesis: jsonb('hypothesis').$type<ProspectHypothesis>(),
  // Per-prospect country override. Most prospects share the organization's
  // country; this column is for the rare case the prospect is in a different
  // country than the org (e.g. distributed team, regional sales rep). Send
  // guardrail prefers prospect.country when set, otherwise falls back to
  // organization.country.
  country: text('country'),
  countrySource: countrySourceEnum('country_source'),
  emailDeliverability: emailDeliverabilityEnum('email_deliverability').notNull().default('unknown'),
  // Discovery-strategy slug; deliberately FK-less like variant_id (strategy
  // definitions live in the sales_strategy document). NULL = provenance not
  // recorded (manual/CSV import, referral-derived, pre-provenance rows).
  discoveryStrategy: text('discovery_strategy'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex('idx_prospect_unique_email')
    .on(table.tenantId, table.email)
    .where(sql`${table.email} IS NOT NULL`),
  uniqueIndex('idx_prospect_unique_form')
    .on(table.tenantId, table.contactFormUrl)
    .where(sql`${table.contactFormUrl} IS NOT NULL`),
  // Required so project_prospects can declare a composite (prospect_id,
  // tenant_id) foreign key that prevents cross-tenant references at write
  // time (defense-in-depth on top of RLS).
  unique('uq_prospect_id_tenant').on(table.id, table.tenantId),
  // Composite FK ties organization_id + tenant_id so a prospect cannot
  // reference an organization in a different tenant. No onDelete: keep the
  // default NO ACTION (an org with prospects cannot be deleted out from
  // under them). Folds in the former single-column .references().
  foreignKey({
    columns: [table.organizationId, table.tenantId],
    foreignColumns: [organizations.id, organizations.tenantId],
    name: 'fk_prospect_org_tenant',
  }),
  index('idx_prospect_tenant').on(table.tenantId),
  index('idx_prospect_org').on(table.organizationId),
])

export const projectProspects = pgTable('project_prospects', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  prospectId: integer('prospect_id').notNull(),
  matchReason: text('match_reason').notNull(),
  priority: smallint('priority').$type<Priority>().notNull().default(3),
  status: prospectStatusEnum('status').notNull().default('new'),
  // Day-scale follow-up axis (P1), kept separate from prospects.next_outreach_after
  // (months-scale) so the two re-eligibility windows never collide. NULL
  // next_followup_after = no sequence in progress.
  nextFollowupAfter: timestamp('next_followup_after', { withTimezone: true }),
  followupTouches: smallint('followup_touches').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_project_prospect').on(table.projectId, table.prospectId),
  check('chk_priority', sql`${table.priority} BETWEEN 1 AND 5`),
  // Composite FKs require tenant_id to match across both ends, so a row in
  // this junction table cannot reference a project / prospect in a different
  // tenant. Single-column .references()` has been moved into these composite
  // declarations — keeping both would duplicate the FK constraint.
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_project_prospect_project_tenant',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.prospectId, table.tenantId],
    foreignColumns: [prospects.id, prospects.tenantId],
    name: 'fk_project_prospect_prospect_tenant',
  }).onDelete('cascade'),
  index('idx_pp_tenant').on(table.tenantId),
  index('idx_pp_project').on(table.projectId),
  index('idx_pp_prospect').on(table.prospectId),
  index('idx_pp_status').on(table.status),
])

export const outreachLogs = pgTable('outreach_logs', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  prospectId: integer('prospect_id').notNull(),
  channel: channelEnum('channel').notNull(),
  subject: text('subject'),
  body: text('body').notNull(),
  status: outreachStatusEnum('status').notNull().default('sent'),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  errorMessage: text('error_message'),
  skipReason: skipReasonEnum('skip_reason'),
  // Subject-line A/B variant id (free-form short slug; no FK so old/removed
  // variants stay analysable). Populated by /outbound when the project has
  // multiple variants registered. NULL when the email used a one-off subject.
  variantId: text('variant_id'),
  // Whether the org had a fresh org_signals_global payload when this outreach
  // was composed (server-computed at insert; the plugin never supplies it).
  hadFreshSignal: boolean('had_fresh_signal').notNull().default(false),
  // Position of this send in its follow-up sequence (1 = initial touch).
  touchNumber: smallint('touch_number').notNull().default(1),
  sendingIdentityId: text('sending_identity_id'),
  fromEmail: text('from_email'),
  // Self-generated RFC822 Message-ID set on the outgoing message (both gmail and
  // smtp arms). The anchor for reply/bounce threading: a reply's In-Reply-To /
  // References or a DSN's returned original Message-ID matching this value is an
  // unforgeable attribution, so it (not sender-recency) gates bounce DNC. Set
  // only when an email send completes (sendAndRecord / sendDraft), so NULL for
  // unsent (pending_review) drafts, form / SNS rows, and sends made before this
  // column existed.
  messageId: text('message_id'),
}, (table) => [
  // Required so responses / inquiry_tokens / inquiry_sessions can declare a
  // composite (outreach_log_id, tenant_id) foreign key (defense-in-depth on
  // top of RLS).
  unique('uq_outreach_id_tenant').on(table.id, table.tenantId),
  // Composite FKs tie project_id / prospect_id to tenant_id so an outreach
  // row cannot reference a project / prospect in a different tenant. The
  // single-column .references() are folded in here.
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_outreach_project_tenant',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.prospectId, table.tenantId],
    foreignColumns: [prospects.id, prospects.tenantId],
    name: 'fk_outreach_prospect_tenant',
  }).onDelete('cascade'),
  index('idx_outreach_tenant').on(table.tenantId),
  index('idx_outreach_project').on(table.projectId),
  index('idx_outreach_prospect').on(table.prospectId),
  index('idx_outreach_dedup').on(table.projectId, table.prospectId, table.status),
  index('idx_outreach_quota').on(table.tenantId, table.status, table.sentAt),
  index('idx_outreach_variant').on(table.projectId, table.variantId, table.status),
])

// Per-project library of subject-line variants. /outbound draws over the active
// rows by the weights in lever_state (recomputed by run_lever_tick); /evaluate
// joins outreachLogs.variantId to compare reply rates. Variants are append-only
// conceptually — `archivedAt` retires a slug from the draw (the tick may set it
// on a dominated variant) while keeping it analysable for historic outreach rows.
export const subjectVariants = pgTable('subject_variants', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  // Short stable slug (e.g. "v1", "warm_intro", "signal_funded").
  variantId: text('variant_id').notNull(),
  // May include {{org}} / {{name}} / {{signal}} placeholders; the LLM
  // substitutes at send time.
  subjectPattern: text('subject_pattern').notNull(),
  label: text('label'),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_subject_variant_project').on(table.projectId, table.variantId),
  // Composite FK ties project_id + tenant_id (defense-in-depth on top of RLS).
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_subject_variant_project_tenant',
  }).onDelete('cascade'),
  index('idx_subject_variants_tenant').on(table.tenantId),
  index('idx_subject_variants_active').on(table.projectId, table.archivedAt),
])

// `channel` is absent on pre-P3 rows and until the project has channel data.
export type LeverDecisionPayload = {
  subject: {
    weights: Record<string, number>
    archived: Array<{ variantId: string; leaderLower: number; armUpper: number; n: number }>
    samples: Array<{ variantId: string; total: number; responses: number; rewardSum: number }>
  }
  channel?: {
    affinity: ChannelAffinityMap
    samples: ChannelCoarseStat[]
  }
}

// Subject-variant draw weights, one row per project. A separate table (not a
// project_settings column) so the daily tick's write never contends with the
// settings PUT path. Missing row → pickSubjectVariant draws uniformly.
export const leverState = pgTable('lever_state', {
  projectId: text('project_id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  variantWeights: jsonb('variant_weights').$type<Record<string, number>>().notNull().default({}),
  // {} = no measured preference → listReachable falls back to policy order.
  channelAffinity: jsonb('channel_affinity').$type<ChannelAffinityMap>().notNull().default({}),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_lever_state_project_tenant',
  }).onDelete('cascade'),
  index('idx_lever_state_tenant').on(table.tenantId),
])

// Append-only tick audit; UNIQUE(project_id, cycle_date) is the idempotency key.
export const leverDecisions = pgTable('lever_decisions', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  cycleDate: date('cycle_date').notNull(),
  decision: jsonb('decision').$type<LeverDecisionPayload>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('uq_lever_decision_cycle').on(table.projectId, table.cycleDate),
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_lever_decision_project_tenant',
  }).onDelete('cascade'),
  index('idx_lever_decisions_tenant').on(table.tenantId),
])

export const responses = pgTable('responses', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  outreachLogId: integer('outreach_log_id').notNull(),
  channel: channelEnum('channel').notNull(),
  content: text('content').notNull(),
  sentiment: sentimentEnum('sentiment').notNull(),
  responseType: responseTypeEnum('response_type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  rejectionFeedback: jsonb('rejection_feedback').$type<RejectionFeedbackV1>(),
  // Captured reply's Message-ID — idempotency key for server-side ingest re-polls.
  // NULL for plugin / form / SNS responses.
  sourceMessageId: text('source_message_id'),
}, (table) => [
  // Required so inquiry_sessions can declare a composite (response_id,
  // tenant_id) foreign key (defense-in-depth on top of RLS).
  unique('uq_response_id_tenant').on(table.id, table.tenantId),
  // Partial so the many NULL source_message_ids (plugin / form / SNS) never collide.
  uniqueIndex('uq_responses_source_message')
    .on(table.tenantId, table.sourceMessageId)
    .where(sql`${table.sourceMessageId} IS NOT NULL`),
  // Composite FK ties outreach_log_id + tenant_id (defense-in-depth on top
  // of RLS). Folds in the former single-column .references().
  foreignKey({
    columns: [table.outreachLogId, table.tenantId],
    foreignColumns: [outreachLogs.id, outreachLogs.tenantId],
    name: 'fk_response_outreach_tenant',
  }).onDelete('cascade'),
  index('idx_responses_tenant').on(table.tenantId),
  index('idx_responses_outreach').on(table.outreachLogId),
])

export const inquiryTokens = pgTable('inquiry_tokens', {
  shortId: text('short_id').primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  prospectId: integer('prospect_id').notNull(),
  outreachLogId: integer('outreach_log_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  // Soft delete via `revoked_at IS NOT NULL` so `inquiry_sessions` history
  // tied to this token stays intact.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  // Required so inquiry_sessions can declare a composite (short_id, tenant_id)
  // foreign key (defense-in-depth on top of RLS).
  unique('uq_inquiry_token_short_id_tenant').on(table.shortId, table.tenantId),
  // Composite FKs tie prospect_id / outreach_log_id to tenant_id. Fold in the
  // former single-column .references().
  foreignKey({
    columns: [table.prospectId, table.tenantId],
    foreignColumns: [prospects.id, prospects.tenantId],
    name: 'fk_inquiry_token_prospect_tenant',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.outreachLogId, table.tenantId],
    foreignColumns: [outreachLogs.id, outreachLogs.tenantId],
    name: 'fk_inquiry_token_outreach_tenant',
  }).onDelete('cascade'),
  index('idx_inquiry_tokens_tenant').on(table.tenantId),
  index('idx_inquiry_tokens_outreach').on(table.outreachLogId),
])

export const inquirySessions = pgTable('inquiry_sessions', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  prospectId: integer('prospect_id').notNull(),
  outreachLogId: integer('outreach_log_id').notNull(),
  shortId: text('short_id').notNull(),
  // Nullable: a session may close without a recorded response. The composite
  // (response_id, tenant_id) FK below enforces same-tenant. No onDelete
  // (NO ACTION): responses are never deleted independently of their
  // outreach_log, and a session cascade-deletes from the same outreach_log,
  // so a response and its session always disappear together — SET NULL would
  // never fire.
  responseId: integer('response_id'),
  outcome: inquiryOutcomeEnum('outcome').notNull().default('opened'),
  meetingRequestSource: meetingRequestSourceEnum('meeting_request_source'),
  derivedSummary: text('derived_summary'),
  chatTurnsUsed: smallint('chat_turns_used').notNull().default(0),
  // Per-prospect chat brief composed at session open. NULL on legacy rows
  // and on sessions whose project has no inquiry_chat_brief configured;
  // buildSystemPrompt falls back to project_settings.inquiry_chat_brief.
  contextSnapshot: jsonb('context_snapshot').$type<InquirySessionContextSnapshot>(),
  openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
}, (table) => [
  index('idx_inquiry_session_tenant').on(table.tenantId),
  index('idx_inquiry_session_prospect').on(table.prospectId),
  index('idx_inquiry_session_outreach').on(table.outreachLogId),
  index('idx_inquiry_session_quota').on(table.tenantId, table.openedAt),
  // At most one open session per token — collapses the concurrent-first-visit
  // race in openLandingSession to a single row.
  uniqueIndex('idx_inquiry_session_open')
    .on(table.shortId)
    .where(sql`${table.closedAt} IS NULL`),
  // Required so inquiry_messages can declare a composite (session_id,
  // tenant_id) foreign key that prevents cross-tenant references at write
  // time (defense-in-depth on top of RLS).
  unique('uq_inquiry_session_id_tenant').on(table.id, table.tenantId),
  // Composite FKs tie prospect_id / outreach_log_id / short_id / response_id
  // to tenant_id. Fold in the former single-column .references().
  foreignKey({
    columns: [table.prospectId, table.tenantId],
    foreignColumns: [prospects.id, prospects.tenantId],
    name: 'fk_inquiry_session_prospect_tenant',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.outreachLogId, table.tenantId],
    foreignColumns: [outreachLogs.id, outreachLogs.tenantId],
    name: 'fk_inquiry_session_outreach_tenant',
  }).onDelete('cascade'),
  foreignKey({
    columns: [table.shortId, table.tenantId],
    foreignColumns: [inquiryTokens.shortId, inquiryTokens.tenantId],
    name: 'fk_inquiry_session_token_tenant',
  }).onDelete('cascade'),
  // No onDelete (NO ACTION): see the response_id column comment. Nullable
  // response_id is unchecked by the FK when null (MATCH SIMPLE).
  foreignKey({
    columns: [table.responseId, table.tenantId],
    foreignColumns: [responses.id, responses.tenantId],
    name: 'fk_inquiry_session_response_tenant',
  }),
])

export const inquiryMessages = pgTable('inquiry_messages', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  // Denormalized to match every other tenant-scoped table — keeps the RLS
  // policy uniform and avoids a subquery on inquiry_sessions per row read.
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  sessionId: integer('session_id').notNull(),
  role: inquiryMessageRoleEnum('role').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_inquiry_messages_session').on(table.sessionId, table.createdAt),
  index('idx_inquiry_messages_tenant').on(table.tenantId),
  // Composite FK ties session_id + tenant_id together, so a row in
  // inquiry_messages cannot point at an inquiry_sessions row in a different
  // tenant. The single-column .references() has been moved into this
  // composite declaration — keeping both would duplicate the FK constraint.
  foreignKey({
    columns: [table.sessionId, table.tenantId],
    foreignColumns: [inquirySessions.id, inquirySessions.tenantId],
    name: 'fk_inquiry_messages_session_tenant',
  }).onDelete('cascade'),
])

export const projectDocuments = pgTable('project_documents', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull(),
  // Known values: "business", "sales_strategy", "search_notes".
  slug: text('slug').notNull(),
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  // Composite FK ties project_id + tenant_id (defense-in-depth on top of RLS).
  foreignKey({
    columns: [table.projectId, table.tenantId],
    foreignColumns: [projects.id, projects.tenantId],
    name: 'fk_project_document_project_tenant',
  }).onDelete('cascade'),
  index('idx_doc_tenant').on(table.tenantId),
  index('idx_doc_latest').on(table.projectId, table.slug, table.createdAt),
])

// Global master documents (not tenant-scoped) — populated by SaaS-side seed,
// read by all tenants.
export const masterDocuments = pgTable('master_documents', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  // Known values: "tpl_business", "tpl_email_guidelines", etc.
  slug: text('slug').notNull().unique(),
  content: text('content').notNull(),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

// All fields optional — daily fetchers fill what they can and the LLM
// gracefully degrades when fields are missing. Recency is tracked separately
// in signalsUpdatedAt.
export type OrgSignals = {
  pressReleases?: Array<{ title: string; url?: string; publishedAt?: string }>
  funding?: { round?: string; amount?: string; investors?: string[]; announcedAt?: string }
  hiring?: { totalOpen?: number; departments?: string[]; sampleTitles?: string[]; sourceUrl?: string }
  leadership?: Array<{ name: string; role?: string; sourceUrl?: string }>
  // Free-form notes the LLM may surface verbatim (e.g. "Just launched product
  // X on 2026-04-01"). Kept short to fit comfortably in /outbound prompt.
  highlights?: string[]
}

// Cross-tenant signal cache, keyed on apex domain — global, no RLS,
// populated by SaaS-side daily batch. Multiple tenants pointing to the same
// organization share one cache entry so a tenant that just added an org gets
// the recent signals immediately.
//
// Two timestamps, no double-duty: lastAttemptAt is bumped on EVERY refresh
// attempt and read only by the picker rotation; signalsUpdatedAt is bumped
// only on non-empty extraction and read by freshness gates (NULL = never
// successfully extracted).
export const orgSignalsGlobal = pgTable('org_signals_global', {
  domain: text('domain').primaryKey(),
  signals: jsonb('signals').$type<OrgSignals>(),
  signalsUpdatedAt: timestamp('signals_updated_at', { withTimezone: true }),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

// Reviewed out-of-band by the maintainer — no admin UI yet.
export const BUG_REPORT_CATEGORIES = ['bug', 'feedback', 'idea'] as const
export type BugReportCategory = (typeof BUG_REPORT_CATEGORIES)[number]
export const bugReportCategoryEnum = pgEnum('bug_report_category', BUG_REPORT_CATEGORIES)

export const bugReports = pgTable('bug_reports', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  tenantId: text('tenant_id')
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // Diagnostic context only — RLS is tenant-scoped, not user-scoped.
  userId: text('user_id').notNull(),
  category: bugReportCategoryEnum('category').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  // Caller-supplied; the schema doesn't constrain shape so it can evolve
  // without migrations.
  context: jsonb('context').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_bug_reports_tenant_created').on(table.tenantId, table.createdAt),
])

// Global, NOT tenant-scoped: the row must outlive the tenant cascade-delete,
// which also serves as a GDPR erasure — so it holds no tenant_id / user_id.
export const ACCOUNT_DELETION_REASONS = [
  'too_expensive',
  'not_enough_results',
  'missing_features',
  'too_hard_to_use',
  'switched_to_alternative',
  'no_longer_needed',
  'other',
] as const
export type AccountDeletionReason = (typeof ACCOUNT_DELETION_REASONS)[number]
export const accountDeletionReasonEnum = pgEnum(
  'account_deletion_reason',
  ACCOUNT_DELETION_REASONS,
)

export const accountDeletionSurveys = pgTable('account_deletion_surveys', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  reason: accountDeletionReasonEnum('reason').notNull(),
  detail: text('detail'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
