import { z } from 'zod'
import { eq, ne, and, sql, desc, or, ilike, inArray, isNotNull, isNull, lte, notExists, type SQL } from 'drizzle-orm'
import {
  organizations,
  orgSignalsGlobal,
  prospects,
  projectProspects,
  outreachLogs,
  responses,
  leverState,
  formTypeEnum,
  prospectStatusEnum,
  responseTypeEnum,
  REACHABLE_STATUSES,
  PRE_SEND_TTL_MINUTES,
  OUTBOUND_CHANNELS,
  prioritySchema,
  priorityCoerceSchema,
  type Priority,
  type SnsAccounts,
  type ProspectStatus,
  type ProspectHypothesis,
  type OutboundMode,
  type OutboundChannel,
  type RejectionPrimaryReason,
  type RejectionFeedbackV1,
} from '../db/schema'
import type { Db } from '../db/connection'
import {
  getRemainingOutreachQuota,
  formatOutreachQuotaError,
  isOutreachQuotaExhausted,
  getMailboxDailyQuota,
  isMailboxQuotaExhausted,
  formatMailboxQuotaError,
  type MailboxDailyQuota,
} from './plan-limits'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { resolveSendingIdentityId } from '../auth/google'
import { getOutboundMode, loadProjectOutboundAllowlist } from './project-settings'
import { projectProspectInsertValues } from '../domain/project-prospect'
import { UNDELIVERABLE } from '../domain/email-deliverability'
import type { Edition } from '../domain/edition'
import {
  projectRefSchema,
  prospectIdSchema,
  type ProjectId,
  type ProjectRef,
  type TenantId,
} from '../domain/ids'
import { isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG } from '../domain/url'
import { ALLOWED_SEND_COUNTRIES } from '../domain/country'
import { coarseIndustry } from '../domain/coarse-industry'
import type { ChannelRank } from '../domain/channel-affinity'

// See get_outbound_targets / B §4.2-F.
const SIGNAL_FRESH_DAYS = 14

// Up to 200 targets ride in one JSON response — digest, not the full payload.
const RECENT_SIGNALS_MAX = 3

// The `signals IS NOT NULL` guard keeps legacy rows (failure-bumped
// timestamp, NULL payload) from counting as fresh.
const freshSignalExpr = sql<boolean>`(
  ${orgSignalsGlobal.signals} IS NOT NULL
  AND ${orgSignalsGlobal.signalsUpdatedAt} IS NOT NULL
  AND ${orgSignalsGlobal.signalsUpdatedAt} >= NOW() - (${SIGNAL_FRESH_DAYS} * INTERVAL '1 day')
)`

export async function prospectHadFreshSignal(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ fresh: freshSignalExpr })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)
  return row?.fresh ?? false
}

// Shared by the reachable gate and the byChannel summary so both agree.
const emailUsableExpr: SQL = and(
  isNotNull(prospects.email),
  ne(prospects.emailDeliverability, UNDELIVERABLE),
)!

function channelAvailabilityClause(ch: OutboundChannel): SQL {
  switch (ch) {
    case 'email': return emailUsableExpr
    case 'form': return isNotNull(prospects.contactFormUrl)
    case 'sns_twitter': return sql`${prospects.snsAccounts}->>'x' IS NOT NULL`
    case 'sns_linkedin': return sql`${prospects.snsAccounts}->>'linkedin' IS NOT NULL`
  }
}

export { prospectIdParamSchema } from '../domain/ids'

// Guards outreach_logs inserts (FK prospect_id → prospects.id) so a bogus id
// becomes a clean 404 instead of an unhandled FK-violation 500.
export async function requireProspect(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
): Promise<ServiceResult<undefined>> {
  const [row] = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)
  if (!row) return err('NOT_FOUND', 'Prospect not found')
  return ok(undefined)
}

export const reachableQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type ReachableQuery = z.infer<typeof reachableQuerySchema>

export const listProjectProspectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(prospectStatusEnum.enumValues).optional(),
  priority: priorityCoerceSchema.optional(),
  q: z.string().trim().min(1).optional(),
})
export type ListProjectProspectsQuery = z.infer<typeof listProjectProspectsQuerySchema>

export const listTenantProspectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).optional(),
  industry: z.string().trim().min(1).optional(),
  excludeProjectId: projectRefSchema.optional(),
})
export type ListTenantProspectsQuery = z.infer<typeof listTenantProspectsQuerySchema>

export const updateProspectStatusBodySchema = z.object({
  projectId: projectRefSchema,
  status: z.enum(prospectStatusEnum.enumValues),
})
export type UpdateProspectStatusBody = z.infer<typeof updateProspectStatusBodySchema>

export const updateDoNotContactBodySchema = z.object({
  doNotContact: z.boolean(),
})
export type UpdateDoNotContactBody = z.infer<typeof updateDoNotContactBodySchema>

const snsAccountsSchema = z.object({
  x: z.string().optional(),
  linkedin: z.string().optional(),
  instagram: z.string().optional(),
  facebook: z.string().optional(),
})

const hypothesisSchema = z.object({
  targetDepartment: z.string().optional(),
  targetRolePattern: z.string().optional(),
  hypothesizedPain: z.array(z.string()).optional(),
  valueMapping: z.array(z.string()).optional(),
  timingSignals: z.array(z.string()).optional(),
  bestChannel: z.string().optional(),
  bestKeyperson: z.string().optional(),
})

export const updateProspectBodySchema = z.object({
  name: z.string().min(1).optional(),
  contactName: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  overview: z.string().min(1).optional(),
  industry: z.string().nullable().optional(),
  websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  email: z.email().nullable().optional(),
  contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional(),
  formType: z.enum(formTypeEnum.enumValues).nullable().optional(),
  snsAccounts: snsAccountsSchema.nullable().optional(),
  notes: z.string().nullable().optional(),
  hypothesis: hypothesisSchema.nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/, 'must be ISO 3166-1 alpha-2').nullable().optional(),
  countrySource: z.enum(['manual', 'ai_inferred']).nullable().optional(),
}).strict()
export type UpdateProspectBody = z.infer<typeof updateProspectBodySchema>

export const linkSchema = z.object({
  links: z.array(z.object({
    prospectId: prospectIdSchema,
    matchReason: z.string().min(1),
    priority: prioritySchema.default(3),
  })).min(1).max(200),
})
export type LinkInput = z.infer<typeof linkSchema>

// Per-prospect re-approach context. `n` counts confirmed sends only;
// drafts/failures don't count.
//
//   kind = 'first'              — n === 0
//   kind = 'no_response'        — n > 0, no substantive prior response
//   kind = 'rejection_followup' — n > 0, at least one substantive response
//
// "Substantive" = responseType ∈ {reply, rejection, bounce, meeting_request}.
// Auto-replies excluded so the skill never disambiguates them from real prior
// contact.
// 'short_cycle_followup' = a pending day-scale follow-up touch (P1), vs
// 'no_response' = the months-scale recycle re-send.
export type CycleKind = 'first' | 'no_response' | 'rejection_followup' | 'short_cycle_followup'

export type ReachableCycle = {
  n: number
  kind: CycleKind
  // Which touch the next send is (1 = first). For short_cycle_followup, followup_touches + 1.
  touchNumber: number
  lastOutreach: { sentAt: string; subject: string | null } | null
  lastResponse: {
    receivedAt: string
    responseType: typeof responseTypeEnum.enumValues[number]
    rejectionFeedback: { primaryReason: RejectionPrimaryReason; freeText: string | null } | null
  } | null
}

export type ReachableProspect = {
  ppId: number
  prospectId: number
  name: string
  contactName: string | null
  overview: string
  industry: string | null
  websiteUrl: string
  email: string | null
  contactFormUrl: string | null
  formType: typeof formTypeEnum.enumValues[number] | null
  snsAccounts: SnsAccounts | null
  notes: string | null
  matchReason: string
  priority: Priority
  status: ProspectStatus
  organizationId: number
  // Effective country: prospect override wins, organization country is the
  // fallback. /outbound uses this to skip non-allowed countries before send
  // so the US/CA/JP-only delivery scope is enforced at the skill layer
  // rather than failing 422 at send time.
  country: string | null
  // True when the org has non-empty signals extracted within
  // SIGNAL_FRESH_DAYS. Drives both skill UX and server-side ordering
  // (fresh-signal prospects float up).
  hasFreshSignal: boolean
  // Up to RECENT_SIGNALS_MAX highlights from a fresh org_signals_global
  // payload; absent when it carries none (hasFreshSignal may still be true).
  recentSignals?: string[]
  hypothesis: { bestChannel: string | null; bestKeyperson: string | null }
  channelAffinity: ChannelRank[]
  cycle: ReachableCycle
}

export type ProjectProspectRow = {
  ppId: number
  prospectId: number
  name: string
  contactName: string | null
  overview: string
  industry: string | null
  websiteUrl: string
  email: string | null
  contactFormUrl: string | null
  formType: typeof formTypeEnum.enumValues[number] | null
  snsAccounts: SnsAccounts | null
  doNotContact: boolean
  notes: string | null
  matchReason: string
  priority: Priority
  status: ProspectStatus
  organizationId: number
  organizationName: string
  createdAt: Date
}

// Returns the project IDs the prospect is already linked to so the UI can
// grey out duplicates.
export type TenantProspectRow = {
  id: number
  name: string
  contactName: string | null
  department: string | null
  overview: string
  industry: string | null
  websiteUrl: string
  email: string | null
  contactFormUrl: string | null
  formType: typeof formTypeEnum.enumValues[number] | null
  snsAccounts: SnsAccounts | null
  notes: string | null
  organizationId: number
  organizationDomain: string
  organizationName: string
  createdAt: Date
  linkedProjectIds: string[]
}

export async function listReachable(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  projectRef: ProjectRef,
  query: ReachableQuery,
): Promise<ServiceResult<{
  prospects: ReachableProspect[]
  total: number
  byChannel: { email: number; formOnly: number; snsOnly: number }
  quota: Awaited<ReturnType<typeof getRemainingOutreachQuota>>
  mailboxQuota: MailboxDailyQuota
  outboundMode: OutboundMode
  message?: string
}>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const { limit } = query

  const [quota, mailboxQuota, outboundMode, allowlist] = await Promise.all([
    getRemainingOutreachQuota(db, tenantId, edition),
    // Resolve runs alongside the independent queries; only the mailbox cap depends on it.
    resolveSendingIdentityId(db, { tenantId, projectId }).then((id) =>
      getMailboxDailyQuota(db, tenantId, id),
    ),
    getOutboundMode(db, projectId),
    loadProjectOutboundAllowlist(db, projectId),
  ])

  if (isOutreachQuotaExhausted(quota)) {
    return ok({
      prospects: [],
      total: 0,
      byChannel: { email: 0, formOnly: 0, snsOnly: 0 },
      quota,
      mailboxQuota,
      outboundMode,
      message: formatOutreachQuotaError(quota),
    })
  }

  const allowedSet = new Set(allowlist.outboundChannels)
  const enabledChannels = OUTBOUND_CHANNELS.filter((ch) => allowedSet.has(ch))

  if (enabledChannels.length === 0) {
    return ok({
      prospects: [],
      total: 0,
      byChannel: { email: 0, formOnly: 0, snsOnly: 0 },
      quota,
      mailboxQuota,
      outboundMode,
      message: 'Automated outbound is paused for this project (no channels enabled in project settings).',
    })
  }

  // Email-only cap: targets are still returned (form/SNS unaffected); the note
  // tells the skill to use other channels or wait. The send path is the hard guard.
  const mailboxCappedNote =
    enabledChannels.includes('email') && isMailboxQuotaExhausted(mailboxQuota)
      ? formatMailboxQuotaError(mailboxQuota)
      : undefined

  const effectiveLimit = quota.kind === 'capped' ? Math.min(limit, quota.remaining) : limit

  const channelFilter: SQL | undefined = or(...enabledChannels.map(channelAvailabilityClause))

  // NULL country excluded — explicit allowlist means "only these".
  const countryFilter: SQL | undefined = allowlist.targetCountries.length > 0
    ? inArray(
        sql<string>`COALESCE(${prospects.country}, ${organizations.country})`,
        allowlist.targetCountries,
      )
    : undefined

  // Hard send-target allowlist (US/CA/JP), always on — the deterministic
  // jurisdiction guardrail mirrors isAllowedSendCountry at the candidate
  // stage so the skill never pre-filters by country or fabricates a skip row
  // for an unsupported jurisdiction. NULL passes (warn-and-allow; the send
  // path's 422 is the final gate). Independent of the project's optional
  // targetCountries preference above.
  const hardCountryFilter: SQL | undefined = or(
    isNull(sql`COALESCE(${prospects.country}, ${organizations.country})`),
    inArray(
      // UPPER mirrors isAllowedSendCountry's normalization so the candidate
      // filter and the send-time guard agree regardless of stored casing.
      sql<string>`UPPER(COALESCE(${prospects.country}, ${organizations.country}))`,
      [...ALLOWED_SEND_COUNTRIES],
    ),
  )

  // Excludes prospects with in-flight outreach ('pending_review' or
  // unresolved 'pre_send' within PRE_SEND_TTL_MINUTES). After TTL, pre_send
  // rows are treated as abandoned so the prospect becomes re-pickable —
  // same self-cleanup rule as the quota query in plan-limits.ts. Index
  // `idx_outreach_dedup` (project_id, prospect_id, status) covers the lookup.
  //
  // Status branch:
  //   - 'new' / 'deferred': reachable when next_outreach_after is NULL or past.
  //   - 'contacted': reachable when next_followup_after is past (day-scale
  //     follow-up) OR, only while no sequence is in progress, next_outreach_after
  //     is past (months-scale recycle). The IS NULL guard on the recycle arm keeps
  //     the two windows mutually exclusive so they never collide.
  const reachableCondition = and(
    eq(projectProspects.projectId, projectId),
    eq(projectProspects.tenantId, tenantId),
    eq(prospects.doNotContact, false),
    or(
      and(
        inArray(projectProspects.status, REACHABLE_STATUSES),
        or(isNull(prospects.nextOutreachAfter), lte(prospects.nextOutreachAfter, sql`NOW()`)),
      ),
      and(
        eq(projectProspects.status, 'contacted'),
        isNull(projectProspects.nextFollowupAfter),
        isNotNull(prospects.nextOutreachAfter),
        lte(prospects.nextOutreachAfter, sql`NOW()`),
      ),
      and(
        eq(projectProspects.status, 'contacted'),
        isNotNull(projectProspects.nextFollowupAfter),
        lte(projectProspects.nextFollowupAfter, sql`NOW()`),
      ),
    ),
    channelFilter,
    countryFilter,
    hardCountryFilter,
    notExists(
      db
        .select({ one: sql`1` })
        .from(outreachLogs)
        .where(and(
          eq(outreachLogs.projectId, projectProspects.projectId),
          eq(outreachLogs.prospectId, projectProspects.prospectId),
          or(
            eq(outreachLogs.status, 'pending_review'),
            and(
              eq(outreachLogs.status, 'pre_send'),
              sql`${outreachLogs.sentAt} > NOW() - (${PRE_SEND_TTL_MINUTES} * INTERVAL '1 minute')`,
            ),
          ),
        )),
    ),
  )

  // Stale-signal / signal-less rows are demoted by adding a virtual +1 to
  // their priority for ordering only.
  const orderingPriorityExpr = sql<number>`(${projectProspects.priority} + (CASE WHEN ${freshSignalExpr} THEN 0 ELSE 1 END))`

  const [rows, summaryRows, stateRows] = await Promise.all([
    db
      .select({
        ppId: projectProspects.id,
        prospectId: prospects.id,
        name: prospects.name,
        contactName: prospects.contactName,
        overview: prospects.overview,
        industry: prospects.industry,
        websiteUrl: prospects.websiteUrl,
        email: prospects.email,
        contactFormUrl: prospects.contactFormUrl,
        formType: prospects.formType,
        snsAccounts: prospects.snsAccounts,
        notes: prospects.notes,
        hypothesis: prospects.hypothesis,
        matchReason: projectProspects.matchReason,
        priority: projectProspects.priority,
        status: projectProspects.status,
        nextFollowupAfter: projectProspects.nextFollowupAfter,
        followupTouches: projectProspects.followupTouches,
        organizationId: prospects.organizationId,
        // SQL-side coalesce so the skill never merges two columns and
        // /outbound's pre-flight country gate works on a single field.
        country: sql<string | null>`COALESCE(${prospects.country}, ${organizations.country})`,
        hasFreshSignal: freshSignalExpr,
        signals: orgSignalsGlobal.signals,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
      .where(reachableCondition)
      .orderBy(orderingPriorityExpr, projectProspects.createdAt)
      .limit(effectiveLimit),
    db
      .select({
        total: sql<number>`COUNT(*)::int`,
        email: sql<number>`COUNT(*) FILTER (WHERE ${emailUsableExpr})::int`,
        formOnly: sql<number>`COUNT(*) FILTER (WHERE NOT (${emailUsableExpr}) AND ${prospects.contactFormUrl} IS NOT NULL)::int`,
        snsOnly: sql<number>`COUNT(*) FILTER (WHERE NOT (${emailUsableExpr}) AND ${prospects.contactFormUrl} IS NULL AND ${prospects.snsAccounts} IS NOT NULL)::int`,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(reachableCondition),
    db
      .select({ channelAffinity: leverState.channelAffinity })
      .from(leverState)
      .where(eq(leverState.projectId, projectId))
      .limit(1),
  ])

  const summary = summaryRows[0] ?? { total: 0, email: 0, formOnly: 0, snsOnly: 0 }
  const channelAffinityByBucket = stateRows[0]?.channelAffinity ?? {}

  const prospectIds = rows.map((r) => r.prospectId)
  const cycleByProspect = await loadCycleContext(db, projectId, prospectIds)

  const enriched: ReachableProspect[] = rows.map(
    ({ signals, nextFollowupAfter, followupTouches, ...r }) => {
      const base = cycleByProspect.get(r.prospectId) ?? EMPTY_CYCLE
      // A set next_followup_after means the day-scale arm picked this row — relabel
      // so the skill writes a short nudge, not a months-scale re-approach.
      const cycle: ReachableCycle =
        nextFollowupAfter !== null
          ? { ...base, kind: 'short_cycle_followup', touchNumber: followupTouches + 1 }
          : base
      return {
        ...r,
        hypothesis: {
          bestChannel: r.hypothesis?.bestChannel ?? null,
          bestKeyperson: r.hypothesis?.bestKeyperson ?? null,
        },
        channelAffinity: channelAffinityByBucket[coarseIndustry(r.industry)] ?? [],
        cycle,
        // `signals` is destructured out above so the raw column never leaks out.
        ...(r.hasFreshSignal && signals?.highlights?.length
          ? { recentSignals: signals.highlights.slice(0, RECENT_SIGNALS_MAX) }
          : {}),
      }
    },
  )

  return ok({
    prospects: enriched,
    total: summary.total,
    byChannel: {
      email: summary.email,
      formOnly: summary.formOnly,
      snsOnly: summary.snsOnly,
    },
    quota,
    mailboxQuota,
    outboundMode,
    ...(mailboxCappedNote ? { message: mailboxCappedNote } : {}),
  })
}

const EMPTY_CYCLE: ReachableCycle = {
  n: 0,
  kind: 'first',
  touchNumber: 1,
  lastOutreach: null,
  lastResponse: null,
}

// Auto-replies are excluded so cycle.kind never silently widens
// 'rejection_followup' to include them.
const SUBSTANTIVE_RESPONSE_TYPES: ReadonlyArray<typeof responseTypeEnum.enumValues[number]> = [
  'reply',
  'rejection',
  'bounce',
  'meeting_request',
]

// Drafts / failures excluded from `n` so the count matches "real attempts".
async function loadCycleContext(
  db: Db,
  projectId: ProjectId,
  prospectIds: number[],
): Promise<Map<number, ReachableCycle>> {
  const cycles = new Map<number, ReachableCycle>()
  if (prospectIds.length === 0) return cycles

  const [outreachAgg, responseAgg] = await Promise.all([
    db
      .select({
        prospectId: outreachLogs.prospectId,
        n: sql<number>`COUNT(*)::int`,
        lastSentAt: sql<Date>`MAX(${outreachLogs.sentAt})`,
        lastSubject: sql<string | null>`(ARRAY_AGG(${outreachLogs.subject} ORDER BY ${outreachLogs.sentAt} DESC))[1]`,
      })
      .from(outreachLogs)
      .where(and(
        eq(outreachLogs.projectId, projectId),
        eq(outreachLogs.status, 'sent'),
        inArray(outreachLogs.prospectId, prospectIds),
      ))
      .groupBy(outreachLogs.prospectId),
    db
      .select({
        prospectId: outreachLogs.prospectId,
        lastReceivedAt: sql<Date>`MAX(${responses.receivedAt})`,
        lastResponseType: sql<typeof responseTypeEnum.enumValues[number]>`(ARRAY_AGG(${responses.responseType} ORDER BY ${responses.receivedAt} DESC))[1]`,
        lastRejectionFeedback: sql<RejectionFeedbackV1 | null>`(ARRAY_AGG(${responses.rejectionFeedback} ORDER BY ${responses.receivedAt} DESC))[1]`,
      })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(
        eq(outreachLogs.projectId, projectId),
        inArray(outreachLogs.prospectId, prospectIds),
        inArray(responses.responseType, SUBSTANTIVE_RESPONSE_TYPES),
      ))
      .groupBy(outreachLogs.prospectId),
  ])

  const responseMap = new Map(responseAgg.map((r) => [r.prospectId, r]))

  for (const o of outreachAgg) {
    const resp = responseMap.get(o.prospectId)
    // postgres/cf returns sql<Date> aggregates as strings, not Date — re-wrap
    // before toISOString().
    cycles.set(o.prospectId, {
      n: o.n,
      kind: resp ? 'rejection_followup' : 'no_response',
      touchNumber: 1,
      lastOutreach: { sentAt: new Date(o.lastSentAt).toISOString(), subject: o.lastSubject },
      lastResponse: resp
        ? {
            receivedAt: new Date(resp.lastReceivedAt).toISOString(),
            responseType: resp.lastResponseType,
            rejectionFeedback: resp.lastRejectionFeedback
              ? {
                  primaryReason: resp.lastRejectionFeedback.primary_reason,
                  freeText: resp.lastRejectionFeedback.free_text ?? null,
                }
              : null,
          }
        : null,
    })
  }

  return cycles
}

export async function updateProspectStatus(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
  body: UpdateProspectStatusBody,
): Promise<ServiceResult<{ updated: true; prospectId: number; status: ProspectStatus }>> {
  const { projectId: projectRef, status } = body

  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [pp] = await db
    .update(projectProspects)
    .set({ status, updatedAt: new Date() })
    .where(
      and(
        eq(projectProspects.projectId, projectId),
        eq(projectProspects.prospectId, prospectId),
        eq(projectProspects.tenantId, tenantId),
      ),
    )
    .returning({ id: projectProspects.id })

  if (!pp) {
    return err('NOT_FOUND', 'Prospect not found in this project')
  }

  return ok({ updated: true, prospectId, status })
}

// Shared so the list and single-prospect detail can never drift.
const projectProspectSelection = {
  ppId: projectProspects.id,
  prospectId: prospects.id,
  name: prospects.name,
  contactName: prospects.contactName,
  overview: prospects.overview,
  industry: prospects.industry,
  websiteUrl: prospects.websiteUrl,
  email: prospects.email,
  contactFormUrl: prospects.contactFormUrl,
  formType: prospects.formType,
  snsAccounts: prospects.snsAccounts,
  doNotContact: prospects.doNotContact,
  notes: prospects.notes,
  matchReason: projectProspects.matchReason,
  priority: projectProspects.priority,
  status: projectProspects.status,
  organizationId: prospects.organizationId,
  organizationName: organizations.name,
  createdAt: projectProspects.createdAt,
}

export const projectProspectParamSchema = z.object({
  id: projectRefSchema,
  prospectId: z.coerce.number().int().positive(),
})
export type ProjectProspectParam = z.infer<typeof projectProspectParamSchema>

export async function getProjectProspect(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  prospectId: number,
): Promise<ServiceResult<ProjectProspectRow>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [row] = await db
    .select(projectProspectSelection)
    .from(projectProspects)
    .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
    .where(and(
      eq(projectProspects.projectId, projectId),
      eq(projectProspects.tenantId, tenantId),
      eq(projectProspects.prospectId, prospectId),
    ))
    .limit(1)

  if (!row) return err('NOT_FOUND', 'Prospect not found')
  return ok(row)
}

export async function listProjectProspects(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  query: ListProjectProspectsQuery,
): Promise<ServiceResult<{
  prospects: ProjectProspectRow[]
  total: number
}>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const { limit, offset, status, priority, q } = query

  const conditions = [
    eq(projectProspects.projectId, projectId),
    eq(projectProspects.tenantId, tenantId),
  ]

  if (status) conditions.push(eq(projectProspects.status, status))
  if (priority !== undefined) {
    conditions.push(eq(projectProspects.priority, priority))
  }
  if (q) {
    const like = `%${q}%`
    conditions.push(or(
      ilike(prospects.name, like),
      ilike(prospects.contactName, like),
      ilike(organizations.name, like),
      ilike(organizations.domain, like),
    )!)
  }

  const where = and(...conditions)

  const [rows, countRows] = await Promise.all([
    db
      .select(projectProspectSelection)
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(where)
      .orderBy(
        projectProspects.priority,
        desc(projectProspects.createdAt),
        desc(projectProspects.prospectId),
      )
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(where),
  ])

  return ok({
    prospects: rows,
    total: countRows[0]?.total ?? 0,
  })
}

export async function listTenantProspects(
  db: Db,
  tenantId: TenantId,
  query: ListTenantProspectsQuery,
): Promise<ServiceResult<{
  prospects: TenantProspectRow[]
  total: number
}>> {
  const { limit, offset, q, industry, excludeProjectId: excludeProjectRef } = query

  let excludeProjectId: ProjectId | null = null
  if (excludeProjectRef) {
    const resolved = await resolveProject(db, tenantId, excludeProjectRef)
    if (!resolved.ok) return resolved
    excludeProjectId = resolved.value
  }

  const conditions = [
    eq(prospects.tenantId, tenantId),
    eq(prospects.doNotContact, false),
  ]

  if (industry) {
    conditions.push(eq(prospects.industry, industry))
  }

  if (q) {
    const like = `%${q}%`
    conditions.push(
      or(
        ilike(prospects.name, like),
        ilike(prospects.overview, like),
        ilike(prospects.industry, like),
        ilike(organizations.name, like),
      )!,
    )
  }

  if (excludeProjectId) {
    conditions.push(
      notExists(
        db
          .select({ one: sql`1` })
          .from(projectProspects)
          .where(and(
            eq(projectProspects.prospectId, prospects.id),
            eq(projectProspects.projectId, excludeProjectId),
          )),
      ),
    )
  }

  const where = and(...conditions)

  const [rows, countRows] = await Promise.all([
    db
      .select({
        id: prospects.id,
        name: prospects.name,
        contactName: prospects.contactName,
        department: prospects.department,
        overview: prospects.overview,
        industry: prospects.industry,
        websiteUrl: prospects.websiteUrl,
        email: prospects.email,
        contactFormUrl: prospects.contactFormUrl,
        formType: prospects.formType,
        snsAccounts: prospects.snsAccounts,
        notes: prospects.notes,
        organizationId: prospects.organizationId,
        organizationDomain: organizations.domain,
        organizationName: organizations.name,
        createdAt: prospects.createdAt,
        linkedProjectIds: sql<string[]>`COALESCE(array_agg(DISTINCT ${projectProspects.projectId}) FILTER (WHERE ${projectProspects.projectId} IS NOT NULL), '{}')`,
      })
      .from(prospects)
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(projectProspects, eq(projectProspects.prospectId, prospects.id))
      .where(where)
      .groupBy(prospects.id, organizations.id)
      .orderBy(desc(prospects.createdAt), desc(prospects.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(prospects)
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(where),
  ])

  return ok({ prospects: rows, total: countRows[0]?.total ?? 0 })
}

type LinkSkipped = { prospectId: number; reason: string }

export type LinkResult = {
  linked: number
  alreadyLinked: number
  skipped: number
  linkedIds: number[]
  alreadyLinkedIds: number[]
  skippedDetails: LinkSkipped[]
}

export async function linkProspects(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
  input: LinkInput,
): Promise<ServiceResult<LinkResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const { links } = input
  const ids = links.map((l) => l.prospectId)
  const existing = await db
    .select({ id: prospects.id, doNotContact: prospects.doNotContact })
    .from(prospects)
    .where(and(eq(prospects.tenantId, tenantId), inArray(prospects.id, ids)))

  const byId = new Map(existing.map((r) => [r.id, r]))
  const skipped: LinkSkipped[] = []
  const candidates: typeof links = []

  for (const link of links) {
    const row = byId.get(link.prospectId)
    if (!row) {
      skipped.push({ prospectId: link.prospectId, reason: 'not_found' })
      continue
    }
    if (row.doNotContact) {
      skipped.push({ prospectId: link.prospectId, reason: 'do_not_contact' })
      continue
    }
    candidates.push(link)
  }

  let linkedIds: number[] = []
  if (candidates.length > 0) {
    const now = new Date()
    const inserted = await db
      .insert(projectProspects)
      .values(candidates.map((link) => projectProspectInsertValues({
        tenantId,
        projectId,
        prospectId: link.prospectId,
        matchReason: link.matchReason,
        priority: link.priority,
        now,
      })))
      .onConflictDoNothing({ target: [projectProspects.projectId, projectProspects.prospectId] })
      .returning({ prospectId: projectProspects.prospectId })

    linkedIds = inserted.map((r) => r.prospectId)
  }

  const linkedSet = new Set(linkedIds)
  const alreadyLinkedIds = candidates
    .map((l) => l.prospectId)
    .filter((id) => !linkedSet.has(id))

  return ok({
    linked: linkedIds.length,
    alreadyLinked: alreadyLinkedIds.length,
    skipped: skipped.length,
    linkedIds,
    alreadyLinkedIds,
    skippedDetails: skipped,
  })
}

// Per-project junction fields (status / matchReason / priority) live on
// project_prospects, owned by updateProspectStatus + linkProspects. Invariant:
// after the merge at least one contact channel must remain, otherwise the
// prospect becomes unreachable.
export async function updateProspect(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
  patch: UpdateProspectBody,
): Promise<ServiceResult<{ updated: true; prospectId: number; emailToVerify?: string }>> {
  const [existing] = await db
    .select({
      email: prospects.email,
      contactFormUrl: prospects.contactFormUrl,
      snsAccounts: prospects.snsAccounts,
    })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)

  if (!existing) return err('NOT_FOUND', 'Prospect not found')

  const finalEmail = patch.email !== undefined ? patch.email : existing.email
  const finalForm = patch.contactFormUrl !== undefined ? patch.contactFormUrl : existing.contactFormUrl
  const finalSns = patch.snsAccounts !== undefined ? patch.snsAccounts : existing.snsAccounts
  const hasSns = finalSns && Object.values(finalSns).some(Boolean)
  if (!finalEmail && !finalForm && !hasSns) {
    return err(
      'UNPROCESSABLE',
      'At least one contact channel (email, contactFormUrl, or snsAccounts) is required',
    )
  }

  // Reset the deliverability verdict only on an actual email change (the existing
  // row is already loaded), so re-submitting the same address keeps any prior
  // 'undeliverable' verdict and skips a redundant background re-stamp.
  const emailChanged = patch.email !== undefined && patch.email !== existing.email
  const updateSet = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
    ...(patch.department !== undefined ? { department: patch.department } : {}),
    ...(patch.overview !== undefined ? { overview: patch.overview } : {}),
    ...(patch.industry !== undefined ? { industry: patch.industry } : {}),
    ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(emailChanged ? { emailDeliverability: 'unknown' as const } : {}),
    ...(patch.contactFormUrl !== undefined ? { contactFormUrl: patch.contactFormUrl } : {}),
    ...(patch.formType !== undefined ? { formType: patch.formType } : {}),
    ...(patch.snsAccounts !== undefined ? { snsAccounts: patch.snsAccounts } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.hypothesis !== undefined ? { hypothesis: patch.hypothesis as ProspectHypothesis | null } : {}),
    ...(patch.country !== undefined ? { country: patch.country?.toUpperCase() ?? null } : {}),
    ...(patch.countrySource !== undefined ? { countrySource: patch.countrySource } : {}),
  }

  if (Object.keys(updateSet).length === 0) {
    return ok({ updated: true, prospectId })
  }

  try {
    await db
      .update(prospects)
      .set({ ...updateSet, updatedAt: new Date() })
      .where(eq(prospects.id, prospectId))
  } catch (e) {
    if (e instanceof Error && (/duplicate key|unique constraint|23505/i.test(e.message))) {
      return err(
        'CONFLICT',
        'Email or contact form URL is already used by another prospect in this workspace',
      )
    }
    throw e
  }

  const emailToVerify = emailChanged && typeof patch.email === 'string' ? patch.email : undefined
  return ok({ updated: true, prospectId, emailToVerify })
}

export async function updateDoNotContact(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
  body: UpdateDoNotContactBody,
): Promise<ServiceResult<{ updated: true; prospectId: number; doNotContact: boolean }>> {
  const { doNotContact } = body

  const [owned] = await db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)

  if (!owned) {
    return err('NOT_FOUND', 'Prospect not found')
  }

  await db
    .update(prospects)
    .set({ doNotContact, updatedAt: new Date() })
    .where(eq(prospects.id, prospectId))

  return ok({ updated: true, prospectId, doNotContact })
}
