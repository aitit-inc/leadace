import { z } from 'zod'
import { eq, ne, and, sql, desc, or, ilike, inArray, notInArray, isNotNull, isNull, lte, exists, notExists, type SQL } from 'drizzle-orm'
import {
  organizations,
  prospects,
  projectProspects,
  outreachLogs,
  responses,
  leverState,
  formTypeEnum,
  prospectStatusEnum,
  responseTypeEnum,
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
  getRemainingProspectQuota,
  formatContactQuotaError,
  isContactQuotaExhausted,
  isMailboxQuotaExhausted,
  formatMailboxQuotaError,
  type MailboxDailyQuota,
  type ProspectQuota,
  livePreSend,
} from './plan-limits'
import { creditsCoverOverage, USAGE_PRICE_CENTS } from '../domain/credits'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { pickProjectMailbox } from './mailbox'
import { getOutboundMode, loadLeverConfig, loadProjectOutboundAllowlist } from './project-settings'
import { getActiveStrategySlugs } from './discovery-strategies'
import {
  PRIORITY_MULTIPLIERS,
} from '../domain/targeting-score'
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
import { coarseIndustry, isKnownIndustry } from '../domain/coarse-industry'
import { siteReadPatch } from '../domain/site-read'
import type { ChannelRank } from '../domain/channel-affinity'
import { drawExploreSlots } from '../domain/discovery-allocation'
import { floorRescuedWeights } from '../domain/arm-bandit'
import type { JobOrigin } from '../domain/jobs'
import type { ReachArm } from '../domain/cycle-plan'

// Shared by the reachable gate and the byChannel summary so both agree.
const emailUsableExpr: SQL = and(
  isNotNull(prospects.email),
  ne(prospects.emailDeliverability, UNDELIVERABLE),
  eq(prospects.emailNoSolicitation, false),
)!
const formUsableExpr: SQL = and(
  isNotNull(prospects.contactFormUrl),
  eq(prospects.formNoSolicitation, false),
)!

function channelAvailabilityClause(ch: OutboundChannel): SQL {
  switch (ch) {
    case 'email': return emailUsableExpr
    case 'form': return formUsableExpr
    case 'sns_twitter': return sql`${prospects.snsAccounts}->>'x' IS NOT NULL`
    case 'sns_linkedin': return sql`${prospects.snsAccounts}->>'linkedin' IS NOT NULL`
    case 'platform': return isNotNull(prospects.platformUrl)
  }
}

const hasContactExpr: SQL = or(
  isNotNull(prospects.email),
  isNotNull(prospects.contactFormUrl),
  isNotNull(prospects.snsAccounts),
  isNotNull(prospects.platformUrl),
)!

// A project prospect the project works on. The rest are candidates the hosted
// discovery registered only so it does not read them again (not qualified, or
// no contact on file).
export const projectTargetExpr: SQL = and(eq(projectProspects.qualified, true), hasContactExpr)!

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
  // Restrict to these prospects (still subject to every reachability gate) —
  // "send to these ten" from the chat. Comma-separated on the wire.
  prospectIds: z
    .string()
    .transform((s) => s.split(',').map((v) => v.trim()).filter((v) => v !== '').map(Number))
    .pipe(z.array(z.number().int().positive()).min(1).max(200))
    .optional(),
})
export type ReachableQuery = z.infer<typeof reachableQuerySchema>

export const listProjectProspectsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(prospectStatusEnum.enumValues).optional(),
  priority: priorityCoerceSchema.optional(),
  q: z.string().trim().min(1).optional(),
  // 'all' adds the candidates projectTargetExpr leaves out.
  scope: z.enum(['targets', 'all']).default('targets'),
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

export const updateProspectPriorityBodySchema = z.object({
  projectId: projectRefSchema,
  priority: prioritySchema,
})
export type UpdateProspectPriorityBody = z.infer<typeof updateProspectPriorityBodySchema>

export const setProspectTargetBodySchema = z.object({
  prospectIds: z.array(z.number().int().positive()).min(1).max(200),
  target: z.boolean(),
})
export type SetProspectTargetBody = z.infer<typeof setProspectTargetBodySchema>

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
  // Hard 400 — a single-row PATCH has no partial-success contract to keep.
  industry: z
    .string()
    .trim()
    .nullable()
    .optional()
    .refine((v) => v == null || isKnownIndustry(v), 'not in the tpl_industries vocabulary'),
  websiteUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).optional(),
  email: z.email().nullable().optional(),
  emailNoSolicitation: z.boolean().optional(),
  contactFormUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional(),
  formNoSolicitation: z.boolean().optional(),
  formType: z.enum(formTypeEnum.enumValues).nullable().optional(),
  snsAccounts: snsAccountsSchema.nullable().optional(),
  platformUrl: z.url().refine(isHttpOrHttpsUrl, HTTP_OR_HTTPS_ONLY_MSG).nullable().optional(),
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
// 'short_cycle_followup' = a pending day-scale follow-up touch, vs
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
  platformUrl: string | null
  // /outbound resolves playbook_<slug> for 'platform' targets from this.
  discoveryStrategy: string | null
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
  hypothesis: {
    bestChannel: string | null
    bestKeyperson: string | null
    hypothesizedPain?: string[]
    timingSignals?: string[]
  }
  // ISO; null = never read for timingSignals.
  siteReadAt: string | null
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
  platformUrl: string | null
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
  platformUrl: string | null
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
  query: ReachableQuery & {
    // Draw only prospects these channels reach (within the enabled ones);
    // total and byChannel still count the whole reachable list.
    channels?: readonly OutboundChannel[]
    excludeProspectIds?: number[]
    // One arm only, the counts included; all three without it.
    arm?: ReachArm
  },
): Promise<ServiceResult<{
  prospects: ReachableProspect[]
  total: number
  // The part of total the requested channels reach; all of it without them.
  withinChannels: number
  byChannel: { email: number; formOnly: number; snsOnly: number; platformOnly: number }
  quota: ProspectQuota
  mailboxQuota: MailboxDailyQuota
  outboundMode: OutboundMode
  // True when no outbound can run today whatever the list holds (no channel
  // enabled); `message` then carries the reason. A spent prospect allowance
  // does not block: the list narrows to follow-ups and `message` says so.
  outboundBlocked: boolean
  message?: string
}>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const { limit, prospectIds: onlyProspectIds, channels, excludeProspectIds, arm } = query

  const [quota, mailboxQuota, outboundMode, allowlist, leverConfig, stateRows, activeStrategySlugs] = await Promise.all([
    getRemainingProspectQuota(db, tenantId, edition),
    pickProjectMailbox(db, tenantId, projectId),
    getOutboundMode(db, projectId),
    loadProjectOutboundAllowlist(db, projectId),
    loadLeverConfig(db, projectId),
    db
      .select({
        channelAffinity: leverState.channelAffinity,
        targetingLifts: leverState.targetingLifts,
        strategyWeights: leverState.strategyWeights,
      })
      .from(leverState)
      .where(eq(leverState.projectId, projectId))
      .limit(1),
    getActiveStrategySlugs(db, projectId),
  ])

  // Past the allowance only prospects already contacted are drawn (a
  // follow-up is free); the send path refuses a first touch regardless.
  const followupsOnly = isContactQuotaExhausted(quota)

  const allowedSet = new Set(allowlist.outboundChannels)
  const enabledChannels = OUTBOUND_CHANNELS.filter((ch) => allowedSet.has(ch))

  if (enabledChannels.length === 0) {
    return ok({
      prospects: [],
      total: 0,
      withinChannels: 0,
      byChannel: { email: 0, formOnly: 0, snsOnly: 0, platformOnly: 0 },
      quota,
      mailboxQuota,
      outboundMode,
      outboundBlocked: true,
      message: 'Automated outbound is paused for this project (no channels enabled in project settings).',
    })
  }

  const drawChannels = channels ? enabledChannels.filter((ch) => channels.includes(ch)) : enabledChannels
  // Narrowed to channels the project has off: nothing is drawn, while the
  // counts still show what the enabled channels reach.
  const drawOff =
    channels && drawChannels.length === 0
      ? `Outbound by ${channels.join(' / ')} is not enabled for this project (project settings).`
      : null

  // Email-only cap: targets are still returned (form/SNS unaffected); the note
  // tells the skill to use other channels or wait. The send path is the hard guard.
  const mailboxCappedNote =
    enabledChannels.includes('email') && isMailboxQuotaExhausted(mailboxQuota)
      ? formatMailboxQuotaError(mailboxQuota)
      : undefined

  // Follow-ups never spend the allowance, so the draw is not sized by it;
  // the first touches among the drawn rows are capped after the draw.
  const firstTouchCap = quota.kind === 'capped' && !creditsCoverOverage(quota.credits, USAGE_PRICE_CENTS.contacted) ? quota.contacted.remaining : null

  const channelFilter: SQL | undefined = or(...enabledChannels.map(channelAvailabilityClause))
  const drawFilter: SQL = or(...drawChannels.map(channelAvailabilityClause)) ?? sql`false`

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

  // A 'contacted' prospect is a re-approach only while no follow-up sequence is
  // in progress: the IS NULL guard keeps the two windows from colliding.
  const outreachDue = or(isNull(prospects.nextOutreachAfter), lte(prospects.nextOutreachAfter, sql`NOW()`))
  const armConditions: Record<ReachArm, SQL | undefined> = {
    first: and(eq(projectProspects.status, 'new'), outreachDue),
    recycle: or(
      and(eq(projectProspects.status, 'deferred'), outreachDue),
      and(
        eq(projectProspects.status, 'contacted'),
        isNull(projectProspects.nextFollowupAfter),
        isNotNull(prospects.nextOutreachAfter),
        lte(prospects.nextOutreachAfter, sql`NOW()`),
      ),
    ),
    followup: and(
      eq(projectProspects.status, 'contacted'),
      isNotNull(projectProspects.nextFollowupAfter),
      lte(projectProspects.nextFollowupAfter, sql`NOW()`),
    ),
  }

  // Excludes prospects with in-flight outreach ('pending_review' or a live
  // 'pre_send' — same rule as the quota query, see livePreSend). Index
  // `idx_outreach_dedup` (project_id, prospect_id, status) covers the lookup.
  const reachableCondition = and(
    eq(projectProspects.projectId, projectId),
    eq(projectProspects.tenantId, tenantId),
    onlyProspectIds ? inArray(projectProspects.prospectId, onlyProspectIds) : undefined,
    excludeProspectIds?.length ? notInArray(projectProspects.prospectId, excludeProspectIds) : undefined,
    eq(projectProspects.qualified, true),
    eq(prospects.doNotContact, false),
    eq(organizations.doNotContact, false),
    arm ? armConditions[arm] : or(...Object.values(armConditions)),
    channelFilter,
    countryFilter,
    hardCountryFilter,
    followupsOnly
      ? exists(
          db
            .select({ one: sql`1` })
            .from(outreachLogs)
            .where(and(
              eq(outreachLogs.tenantId, tenantId),
              eq(outreachLogs.prospectId, projectProspects.prospectId),
              eq(outreachLogs.status, 'sent'),
            )),
        )
      : undefined,
    notExists(
      db
        .select({ one: sql`1` })
        .from(outreachLogs)
        .where(and(
          eq(outreachLogs.projectId, projectProspects.projectId),
          eq(outreachLogs.prospectId, projectProspects.prospectId),
          or(eq(outreachLogs.status, 'pending_review'), livePreSend()),
        )),
    ),
  )

  const drawCondition = and(reachableCondition, drawFilter)

  const orderingScoreExpr = sql<number>`(${projectProspects.orderingScore}
    * (CASE ${projectProspects.priority}
        WHEN 1 THEN ${PRIORITY_MULTIPLIERS[1]}::float8
        WHEN 2 THEN ${PRIORITY_MULTIPLIERS[2]}::float8
        WHEN 3 THEN ${PRIORITY_MULTIPLIERS[3]}::float8
        WHEN 4 THEN ${PRIORITY_MULTIPLIERS[4]}::float8
        ELSE ${PRIORITY_MULTIPLIERS[5]}::float8 END))`

  // At equal fit a first touch (a new sample) outranks a silent prospect's
  // re-approach (a retry): docs/send_decision_design.local.md §4.
  const recycleArmExpr = sql<number>`(CASE WHEN ${projectProspects.status} = 'contacted' AND ${projectProspects.nextFollowupAfter} IS NULL THEN 1 ELSE 0 END)`

  const exploreCount = Math.floor(limit * leverConfig.explorationShare)
  const topCount = limit - exploreCount

  const reachableSelect = () =>
    db
      .select({
        ppId: projectProspects.id,
        prospectId: prospects.id,
        name: prospects.name,
        contactName: prospects.contactName,
        overview: prospects.overview,
        industry: prospects.industry,
        websiteUrl: prospects.websiteUrl,
        // Readers of this list see only channels they may use.
        email: sql<string | null>`CASE WHEN ${prospects.emailNoSolicitation} THEN NULL ELSE ${prospects.email} END`,
        contactFormUrl: sql<string | null>`CASE WHEN ${prospects.formNoSolicitation} THEN NULL ELSE ${prospects.contactFormUrl} END`,
        formType: sql<(typeof formTypeEnum.enumValues)[number] | null>`CASE WHEN ${prospects.formNoSolicitation} THEN NULL ELSE ${prospects.formType} END`,
        snsAccounts: prospects.snsAccounts,
        platformUrl: prospects.platformUrl,
        discoveryStrategy: prospects.discoveryStrategy,
        notes: prospects.notes,
        hypothesis: prospects.hypothesis,
        siteReadAt: prospects.siteReadAt,
        matchReason: projectProspects.matchReason,
        priority: projectProspects.priority,
        status: projectProspects.status,
        nextFollowupAfter: projectProspects.nextFollowupAfter,
        followupTouches: projectProspects.followupTouches,
        contactedBefore: sql<boolean>`${exists(
          db
            .select({ one: sql`1` })
            .from(outreachLogs)
            .where(and(
              eq(outreachLogs.tenantId, tenantId),
              eq(outreachLogs.prospectId, projectProspects.prospectId),
              eq(outreachLogs.status, 'sent'),
            )),
        )}`,
        organizationId: prospects.organizationId,
        // SQL-side coalesce so the skill never merges two columns and
        // /outbound's pre-flight country gate works on a single field.
        country: sql<string | null>`COALESCE(${prospects.country}, ${organizations.country})`,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))

  const [topRows, summaryRows] = await Promise.all([
    topCount > 0
      ? reachableSelect()
          .where(drawCondition)
          .orderBy(desc(orderingScoreExpr), recycleArmExpr, projectProspects.createdAt, projectProspects.id)
          .limit(topCount)
      : Promise.resolve([]),
    db
      .select({
        total: sql<number>`COUNT(*)::int`,
        withinChannels: sql<number>`COUNT(*) FILTER (WHERE ${drawFilter})::int`,
        email: sql<number>`COUNT(*) FILTER (WHERE ${emailUsableExpr})::int`,
        formOnly: sql<number>`COUNT(*) FILTER (WHERE NOT (${emailUsableExpr}) AND ${formUsableExpr})::int`,
        snsOnly: sql<number>`COUNT(*) FILTER (WHERE NOT (${emailUsableExpr}) AND NOT (${formUsableExpr}) AND ${prospects.snsAccounts} IS NOT NULL)::int`,
        platformOnly: sql<number>`COUNT(*) FILTER (WHERE NOT (${emailUsableExpr}) AND NOT (${formUsableExpr}) AND ${prospects.snsAccounts} IS NULL AND ${prospects.platformUrl} IS NOT NULL)::int`,
      })
      .from(projectProspects)
      .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(reachableCondition),
  ])

  // Stratified exploration: each explore slot draws a stratum from the tick's
  // weights, then a random reachable prospect within it. The unattributed
  // stratum keeps no-strategy prospects (CSV imports, ad-hoc) in the
  // exploration lane — without it the ordering becomes for them the de-facto
  // selection gate explorationShare exists to prevent. Strata are disjoint,
  // so their fills run concurrently; any shortfall falls back to a fully
  // random draw.
  // Sequential after the top query: every draw must exclude the top picks.
  const topIds = topRows.map((r) => r.ppId)
  // '*' cannot collide with a slug (slugs are kebab-case).
  const UNATTRIBUTED_STRATUM = '*'
  const liveWeights = {
    ...floorRescuedWeights(
      activeStrategySlugs,
      stateRows[0]?.strategyWeights ?? {},
      leverConfig.strategyWeightFloor,
    ),
    [UNATTRIBUTED_STRATUM]: leverConfig.strategyWeightFloor,
  }
  const slotCounts = exploreCount > 0 ? drawExploreSlots(liveWeights, exploreCount, Math.random) : {}
  const strataRows = (await Promise.all(
    Object.entries(slotCounts).map(([slug, count]) =>
      reachableSelect()
        .where(and(
          drawCondition,
          slug === UNATTRIBUTED_STRATUM
            ? activeStrategySlugs.length > 0
              ? or(
                  isNull(prospects.discoveryStrategy),
                  notInArray(prospects.discoveryStrategy, activeStrategySlugs),
                )
              : undefined
            : eq(prospects.discoveryStrategy, slug),
          topIds.length > 0 ? notInArray(projectProspects.id, topIds) : undefined,
        ))
        .orderBy(sql`random()`)
        .limit(count),
    ),
  )).flat()
  const pickedIds = [...topIds, ...strataRows.map((r) => r.ppId)]
  const shortfall = exploreCount - strataRows.length
  const fallbackRows =
    shortfall > 0
      ? await reachableSelect()
          .where(and(
            drawCondition,
            pickedIds.length > 0 ? notInArray(projectProspects.id, pickedIds) : undefined,
          ))
          .orderBy(sql`random()`)
          .limit(shortfall)
      : []
  const drawnRows = [...topRows, ...strataRows, ...fallbackRows]
  const rows = firstTouchCap === null ? drawnRows : capFirstTouches(drawnRows, firstTouchCap)

  const summary = summaryRows[0] ?? { total: 0, withinChannels: 0, email: 0, formOnly: 0, snsOnly: 0, platformOnly: 0 }
  const channelAffinityByBucket = stateRows[0]?.channelAffinity ?? {}

  const prospectIds = rows.map((r) => r.prospectId)
  const cycleByProspect = await loadCycleContext(db, projectId, prospectIds)

  const enriched: ReachableProspect[] = rows.map(
    ({ nextFollowupAfter, followupTouches, contactedBefore: _contactedBefore, ...r }) => {
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
          ...(r.hypothesis?.hypothesizedPain?.length
            ? { hypothesizedPain: r.hypothesis.hypothesizedPain }
            : {}),
          ...(r.hypothesis?.timingSignals?.length
            ? { timingSignals: r.hypothesis.timingSignals }
            : {}),
        },
        siteReadAt: r.siteReadAt?.toISOString() ?? null,
        channelAffinity: channelAffinityByBucket[coarseIndustry(r.industry)] ?? [],
        cycle,
      }
    },
  )

  const message = drawOff ?? (followupsOnly ? formatContactQuotaError(quota) : mailboxCappedNote)

  return ok({
    prospects: enriched,
    total: summary.total,
    withinChannels: summary.withinChannels,
    byChannel: {
      email: summary.email,
      formOnly: summary.formOnly,
      snsOnly: summary.snsOnly,
      platformOnly: summary.platformOnly,
    },
    quota,
    mailboxQuota,
    outboundMode,
    outboundBlocked: drawOff !== null,
    ...(message ? { message } : {}),
  })
}

// Keeps every follow-up and the first `cap` first touches, in draw order.
export function capFirstTouches<T extends { contactedBefore: boolean }>(rows: T[], cap: number): T[] {
  let firstTouches = 0
  return rows.filter((r) => r.contactedBefore || firstTouches++ < cap)
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

export async function recordSiteRead(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
  read: { overview: string; timingSignals: string[] },
  now: Date,
): Promise<void> {
  await db
    .update(prospects)
    .set({
      overview: read.overview,
      hypothesis: sql`COALESCE(${prospects.hypothesis}, '{}'::jsonb) || ${JSON.stringify({ timingSignals: read.timingSignals })}::jsonb`,
      siteReadAt: now,
      updatedAt: now,
    })
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
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

  if (status === 'new') {
    const [sent] = await db
      .select({ one: sql`1` })
      .from(outreachLogs)
      .where(
        and(
          eq(outreachLogs.tenantId, tenantId),
          eq(outreachLogs.projectId, projectId),
          eq(outreachLogs.prospectId, prospectId),
          eq(outreachLogs.status, 'sent'),
        ),
      )
      .limit(1)
    if (sent) {
      return err(
        'CONFLICT',
        "Cannot set status to 'new': this prospect has sent outreach in this project. Use 'deferred' to schedule a re-approach instead.",
      )
    }
  }

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

// Deliberately unconditional on status — an explicit override applies even
// after contact, unlike recordEvaluation's status='new' bulk path.
export async function updateProspectPriority(
  db: Db,
  tenantId: TenantId,
  prospectId: number,
  body: UpdateProspectPriorityBody,
): Promise<ServiceResult<{ updated: true; prospectId: number; priority: Priority }>> {
  const resolved = await resolveProject(db, tenantId, body.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const [pp] = await db
    .update(projectProspects)
    .set({ priority: body.priority, updatedAt: new Date() })
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

  return ok({ updated: true, prospectId, priority: body.priority })
}

export async function setProspectTarget(
  db: Db,
  tenantId: TenantId,
  origin: JobOrigin,
  projectRef: ProjectRef,
  body: SetProspectTargetBody,
): Promise<ServiceResult<{ updatedIds: number[]; notInProjectIds: number[] }>> {
  // Widening past Ace's check needs the person: the web UI, or the chat's
  // approval card. An MCP client has no card to show.
  if (body.target && origin !== 'ui' && origin !== 'chat') {
    return err('FORBIDDEN', 'Making prospects targets is approved in the Web UI chat only; taking them out (target false) works anywhere')
  }
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved

  const updated = await db
    .update(projectProspects)
    .set({ qualified: body.target, updatedAt: new Date() })
    .where(and(
      eq(projectProspects.projectId, resolved.value),
      eq(projectProspects.tenantId, tenantId),
      inArray(projectProspects.prospectId, body.prospectIds),
    ))
    .returning({ prospectId: projectProspects.prospectId })

  const updatedIds = updated.map((r) => r.prospectId)
  const updatedSet = new Set(updatedIds)
  return ok({ updatedIds, notInProjectIds: [...new Set(body.prospectIds)].filter((id) => !updatedSet.has(id)) })
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
  emailNoSolicitation: prospects.emailNoSolicitation,
  contactFormUrl: prospects.contactFormUrl,
  formType: prospects.formType,
  formNoSolicitation: prospects.formNoSolicitation,
  snsAccounts: prospects.snsAccounts,
  platformUrl: prospects.platformUrl,
  doNotContact: prospects.doNotContact,
  notes: prospects.notes,
  matchReason: projectProspects.matchReason,
  priority: projectProspects.priority,
  status: projectProspects.status,
  qualified: projectProspects.qualified,
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

  const { limit, offset, status, priority, q, scope } = query

  const conditions = [
    eq(projectProspects.projectId, projectId),
    eq(projectProspects.tenantId, tenantId),
  ]

  if (scope === 'targets') conditions.push(projectTargetExpr)

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
    eq(organizations.doNotContact, false),
    hasContactExpr,
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
        emailNoSolicitation: prospects.emailNoSolicitation,
        contactFormUrl: prospects.contactFormUrl,
        formType: prospects.formType,
        formNoSolicitation: prospects.formNoSolicitation,
        snsAccounts: prospects.snsAccounts,
        platformUrl: prospects.platformUrl,
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
    .select({
      id: prospects.id,
      doNotContact: sql<boolean>`${prospects.doNotContact} OR ${organizations.doNotContact}`,
    })
    .from(prospects)
    .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
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
// a patch never removes the last contact channel, otherwise the prospect
// becomes unreachable. A hosted-discovery record that never had one stays
// editable.
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
      platformUrl: prospects.platformUrl,
    })
    .from(prospects)
    .where(and(eq(prospects.id, prospectId), eq(prospects.tenantId, tenantId)))
    .limit(1)

  if (!existing) return err('NOT_FOUND', 'Prospect not found')

  const finalEmail = patch.email !== undefined ? patch.email : existing.email
  const finalForm = patch.contactFormUrl !== undefined ? patch.contactFormUrl : existing.contactFormUrl
  const finalSns = patch.snsAccounts !== undefined ? patch.snsAccounts : existing.snsAccounts
  const finalPlatform = patch.platformUrl !== undefined ? patch.platformUrl : existing.platformUrl
  const hasSns = (sns: typeof finalSns) => sns !== null && Object.values(sns).some(Boolean)
  const hadContact = existing.email || existing.contactFormUrl || hasSns(existing.snsAccounts) || existing.platformUrl
  if (hadContact && !finalEmail && !finalForm && !hasSns(finalSns) && !finalPlatform) {
    return err(
      'UNPROCESSABLE',
      'At least one contact channel (email, contactFormUrl, snsAccounts, or platformUrl) is required',
    )
  }
  if (patch.emailNoSolicitation && !finalEmail) {
    return err('UNPROCESSABLE', 'emailNoSolicitation describes the stored email address, so it requires email')
  }
  if (patch.formNoSolicitation && !finalForm) {
    return err('UNPROCESSABLE', 'formNoSolicitation describes the stored contact form, so it requires contactFormUrl')
  }

  // Reset the deliverability verdict only on an actual email change (the existing
  // row is already loaded), so re-submitting the same address keeps any prior
  // 'undeliverable' verdict and skips a redundant background re-stamp.
  const emailChanged = patch.email !== undefined && patch.email !== existing.email
  const formChanged = patch.contactFormUrl !== undefined && patch.contactFormUrl !== existing.contactFormUrl
  const now = new Date()
  const updateSet = {
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.contactName !== undefined ? { contactName: patch.contactName } : {}),
    ...(patch.department !== undefined ? { department: patch.department } : {}),
    ...(patch.overview !== undefined ? { overview: patch.overview } : {}),
    ...(patch.industry !== undefined ? { industry: patch.industry } : {}),
    ...(patch.websiteUrl !== undefined ? { websiteUrl: patch.websiteUrl } : {}),
    ...(patch.email !== undefined ? { email: patch.email } : {}),
    ...(emailChanged ? { emailDeliverability: 'unknown' as const, mailboxVerifiedAt: null, emailNoSolicitation: false } : {}),
    ...(patch.emailNoSolicitation !== undefined ? { emailNoSolicitation: patch.emailNoSolicitation } : {}),
    ...(patch.contactFormUrl !== undefined ? { contactFormUrl: patch.contactFormUrl } : {}),
    ...(formChanged ? { formNoSolicitation: false } : {}),
    ...(patch.formNoSolicitation !== undefined ? { formNoSolicitation: patch.formNoSolicitation } : {}),
    ...(patch.formType !== undefined ? { formType: patch.formType } : {}),
    ...(patch.snsAccounts !== undefined ? { snsAccounts: patch.snsAccounts } : {}),
    ...(patch.platformUrl !== undefined ? { platformUrl: patch.platformUrl } : {}),
    ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
    ...(patch.hypothesis !== undefined ? { hypothesis: patch.hypothesis as ProspectHypothesis | null } : {}),
    ...siteReadPatch(patch.hypothesis, now),
    ...(patch.country !== undefined ? { country: patch.country?.toUpperCase() ?? null } : {}),
    ...(patch.countrySource !== undefined ? { countrySource: patch.countrySource } : {}),
  }

  if (Object.keys(updateSet).length === 0) {
    return ok({ updated: true, prospectId })
  }

  // Checked up front, not by catching 23505: a failed statement aborts the
  // request transaction even when caught.
  const channelMatch = or(
    updateSet.email ? eq(prospects.email, updateSet.email) : undefined,
    updateSet.contactFormUrl ? eq(prospects.contactFormUrl, updateSet.contactFormUrl) : undefined,
    updateSet.platformUrl ? eq(prospects.platformUrl, updateSet.platformUrl) : undefined,
  )
  if (channelMatch) {
    const [taken] = await db
      .select({ id: prospects.id })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), ne(prospects.id, prospectId), channelMatch))
      .limit(1)
    if (taken) {
      return err(
        'CONFLICT',
        'Email, contact form URL, or platform URL is already used by another prospect in this workspace',
      )
    }
  }

  await db
    .update(prospects)
    .set({ ...updateSet, updatedAt: now })
    .where(eq(prospects.id, prospectId))

  const emailToVerify = emailChanged && !patch.emailNoSolicitation && typeof patch.email === 'string' ? patch.email : undefined
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

export const deleteProspectsBodySchema = z.object({
  prospectIds: z.array(prospectIdSchema).min(1).max(200),
})
export type DeleteProspectsBody = z.infer<typeof deleteProspectsBodySchema>

export type ProspectDeleteSkipReason =
  | 'not_found'
  | 'do_not_contact'
  | 'has_outreach_history'
  | 'linked_to_multiple_projects'
  | 'concurrently_modified'

export type ProspectDeleteFlags = {
  exists: boolean
  doNotContact: boolean
  hasOutreachHistory: boolean
  projectLinkCount: number
}

// DNC rows are the suppression list; outreach rows (audit included) cascade away on delete.
export function classifyProspectDeletion(flags: ProspectDeleteFlags): ProspectDeleteSkipReason | null {
  if (!flags.exists) return 'not_found'
  if (flags.doNotContact) return 'do_not_contact'
  if (flags.hasOutreachHistory) return 'has_outreach_history'
  if (flags.projectLinkCount > 1) return 'linked_to_multiple_projects'
  return null
}

export type DeleteProspectsResult = {
  deleted: number
  deletedIds: number[]
  skipped: { prospectId: number; reason: ProspectDeleteSkipReason }[]
  orphanedOrganizationIds: number[]
}

export async function deleteProspects(
  db: Db,
  tenantId: TenantId,
  body: DeleteProspectsBody,
): Promise<ServiceResult<DeleteProspectsResult>> {
  const prospectIds = [...new Set(body.prospectIds)]

  const [rows, outreachRows, linkRows] = await Promise.all([
    db
      .select({
        id: prospects.id,
        doNotContact: prospects.doNotContact,
      })
      .from(prospects)
      .where(and(eq(prospects.tenantId, tenantId), inArray(prospects.id, prospectIds))),
    db
      .selectDistinct({ prospectId: outreachLogs.prospectId })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.tenantId, tenantId), inArray(outreachLogs.prospectId, prospectIds))),
    db
      .select({
        prospectId: projectProspects.prospectId,
        linkCount: sql<number>`COUNT(*)::int`,
      })
      .from(projectProspects)
      .where(and(eq(projectProspects.tenantId, tenantId), inArray(projectProspects.prospectId, prospectIds)))
      .groupBy(projectProspects.prospectId),
  ])

  const hasOutreach = new Set(outreachRows.map((r) => r.prospectId))
  const linkCountById = new Map(linkRows.map((r) => [r.prospectId, r.linkCount]))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const skipped: DeleteProspectsResult['skipped'] = []
  const deletableIds: number[] = []

  for (const prospectId of prospectIds) {
    const row = byId.get(prospectId)
    const reason = classifyProspectDeletion({
      exists: row !== undefined,
      doNotContact: row?.doNotContact ?? false,
      hasOutreachHistory: hasOutreach.has(prospectId),
      projectLinkCount: linkCountById.get(prospectId) ?? 0,
    })
    if (reason) {
      skipped.push({ prospectId, reason })
    } else {
      deletableIds.push(prospectId)
    }
  }

  // Guards re-checked inside the delete: a row changed since classification is refused, not cascaded away.
  const deletedRows =
    deletableIds.length === 0
      ? []
      : await db
          .delete(prospects)
          .where(
            and(
              eq(prospects.tenantId, tenantId),
              inArray(prospects.id, deletableIds),
              eq(prospects.doNotContact, false),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(outreachLogs)
                  .where(
                    and(
                      eq(outreachLogs.tenantId, prospects.tenantId),
                      eq(outreachLogs.prospectId, prospects.id),
                    ),
                  ),
              ),
              sql`(SELECT COUNT(*) FROM ${projectProspects}
                   WHERE ${projectProspects.tenantId} = ${prospects.tenantId}
                     AND ${projectProspects.prospectId} = ${prospects.id}) <= 1`,
            ),
          )
          .returning({ id: prospects.id, organizationId: prospects.organizationId })

  const deletedIds = deletedRows.map((r) => r.id)
  const deletedIdSet = new Set(deletedIds)
  for (const id of deletableIds) {
    if (!deletedIdSet.has(id)) skipped.push({ prospectId: id, reason: 'concurrently_modified' })
  }

  const deletedOrgIds = [...new Set(deletedRows.map((r) => r.organizationId))]
  let orphanedOrganizationIds: number[] = []
  if (deletedOrgIds.length > 0) {
    const stillPopulated = new Set(
      (
        await db
          .selectDistinct({ organizationId: prospects.organizationId })
          .from(prospects)
          .where(
            and(eq(prospects.tenantId, tenantId), inArray(prospects.organizationId, deletedOrgIds)),
          )
      ).map((r) => r.organizationId),
    )
    orphanedOrganizationIds = deletedOrgIds.filter((id) => !stillPopulated.has(id))
  }

  return ok({
    deleted: deletedIds.length,
    deletedIds,
    skipped,
    orphanedOrganizationIds,
  })
}
