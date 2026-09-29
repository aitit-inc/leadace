import { and, asc, count, countDistinct, desc, eq, exists, gt, gte, inArray, isNotNull, isNull, lt, max, not, notInArray, sql, type SQL } from 'drizzle-orm'
import {
  discoveryStrategies,
  INQUIRY_OUTCOMES,
  inquirySessions,
  leverDecisions,
  messageVariants,
  organizations,
  outreachLogs,
  projectProspects,
  prospects,
  responses,
  responseTypeEnum,
  sentimentEnum,
  type Channel,
  type EmployeeBand,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutreachStatus,
} from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../../domain/ids'
import { NON_COUNTABLE_RESPONSE_TYPES, reactionTotalsByKey, REWARDED_INQUIRY_OUTCOMES, sendReaction, type Reaction, type ReactionLevel, type ReactionTotals, type RewardWeights } from '../../domain/loop/reaction'
import { unquotedText } from '../../domain/reply-classify'
import { coarseIndustry, type CoarseIndustry } from '../../domain/coarse-industry'
import { percentOf } from '../../domain/dashboard'
import { type LeverConfig } from '../../domain/loop/config'
import type { ChannelFineStat, TargetingAxisStat, TargetingStats } from '../../domain/loop/allocation'
import type { VariantStat } from '../../domain/loop/options'
import type { TickEvidence } from '../../domain/loop/decide'
import { loadLeverConfig } from '../project-settings'
import { ok, type ServiceResult } from '../result'
import { resolveProject } from '../projects'
import { projectTargetExpr } from '../prospects'
import { getActiveStrategySlugs } from '../discovery-strategies'

// Through the prod transaction pooler (Supavisor, prepare:false) postgres-js
// can't read column type OIDs, so raw db.execute returns numeric/timestamp
// columns as strings (a direct connection parses them to number/Date). Row
// types below are honest about that (`string | number`) and reads normalize
// with Number(...); the bandit relies on it (wilsonBounds compares responses ≤
// total — a string compare would lie).

// `::text` because the bound parameters are text, not the inquiry_outcome enum.
const REWARDED_INQUIRY = sql`s.outcome::text IN (${sql.join(
  REWARDED_INQUIRY_OUTCOMES.map((outcome) => sql`${outcome}`),
  sql`, `,
)})`

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

// The DB clock: every query in one transaction reads the same now().
const daysAgo = (days: number): SQL => sql`now() - make_interval(days => ${days})`
// The epoch is a UTC date.
const dayStart = (date: string): Date => new Date(`${date}T00:00:00Z`)

// Bucket values, one definition for the send counts and the reactions alike.
const industryBucket = (raw: string | null): string | null => raw?.trim() || null
const countryBucket = (prospect: string | null, organization: string | null): string | null =>
  (prospect ?? organization)?.toUpperCase() ?? null

const sentBy = (projectId: ProjectId, where: SQL | undefined): SQL | undefined =>
  and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'sent'), where)

const bounced = (db: Db) =>
  exists(db.select({ id: responses.id }).from(responses).where(and(eq(responses.outreachLogId, outreachLogs.id), eq(responses.responseType, 'bounce'))))

type ReactedSend = {
  outreachLogId: number
  variantId: string | null
  strategy: string | null
  channel: Channel
  industry: string | null
  employeeBand: EmployeeBand
  country: string | null
  priority: number | null
  reaction: Reaction
}

// One row per countable reply or rewarded session of the sends `where` picks,
// so a send's reactions may span rows; each carries every column a caller
// buckets by.
async function reactedSends(db: Db, projectId: ProjectId, where: SQL | undefined): Promise<ReactedSend[]> {
  const send = {
    outreachLogId: outreachLogs.id,
    variantId: outreachLogs.variantId,
    strategy: prospects.discoveryStrategy,
    channel: outreachLogs.channel,
    industry: prospects.industry,
    employeeBand: organizations.employeeBand,
    prospectCountry: prospects.country,
    organizationCountry: organizations.country,
    priority: projectProspects.priority,
  }
  const inProject = and(eq(projectProspects.projectId, outreachLogs.projectId), eq(projectProspects.prospectId, outreachLogs.prospectId))
  const [replies, sessions] = await Promise.all([
    db.select({ ...send, responseType: responses.responseType, sentiment: responses.sentiment })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(projectProspects, inProject)
      .innerJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
      .where(and(sentBy(projectId, where), notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES]))),
    db.select({ ...send, outcome: inquirySessions.outcome })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(projectProspects, inProject)
      .innerJoin(inquirySessions, eq(inquirySessions.outreachLogId, outreachLogs.id))
      .where(and(sentBy(projectId, where), inArray(inquirySessions.outcome, REWARDED_INQUIRY_OUTCOMES))),
  ])
  const bucketed = ({ prospectCountry, organizationCountry, industry, ...rest }: typeof replies[number] | typeof sessions[number]) => ({
    outreachLogId: rest.outreachLogId,
    variantId: rest.variantId,
    strategy: rest.strategy,
    channel: rest.channel,
    employeeBand: rest.employeeBand,
    priority: rest.priority,
    industry: industryBucket(industry),
    country: countryBucket(prospectCountry, organizationCountry),
  })
  return [
    ...replies.map((r) => ({ ...bucketed(r), reaction: { kind: 'reply' as const, responseType: r.responseType, sentiment: r.sentiment } })),
    ...sessions.map((r) => ({ ...bucketed(r), reaction: { kind: 'inquiry' as const, outcome: r.outcome } })),
  ]
}

// Per bucket, by the one reward definition (domain/loop/reaction).
function reactionsBy(rows: ReactedSend[], key: (row: ReactedSend) => string | null, weights: RewardWeights): Map<string | null, ReactionTotals> {
  return reactionTotalsByKey(rows.map((row) => ({ key: key(row), outreachLogId: row.outreachLogId, reaction: row.reaction })), weights)
}

// Sums counts whose raw values fold into one bucket.
function foldCounts<T>(rows: readonly T[], key: (row: T) => string | null, n: (row: T) => number): Map<string | null, number> {
  const out = new Map<string | null, number>()
  for (const row of rows) out.set(key(row), (out.get(key(row)) ?? 0) + n(row))
  return out
}

type SendCounts = { total: number; responses: number; bounces: number; bounceEligible: number }

function foldSends<T extends SendCounts, K>(rows: readonly T[], key: (row: T) => K): Map<K, SendCounts> {
  const out = new Map<K, SendCounts>()
  for (const row of rows) {
    const held = out.get(key(row)) ?? { total: 0, responses: 0, bounces: 0, bounceEligible: 0 }
    out.set(key(row), {
      total: held.total + row.total,
      responses: held.responses + row.responses,
      bounces: held.bounces + row.bounces,
      bounceEligible: held.bounceEligible + row.bounceEligible,
    })
  }
  return out
}

// Settling is per send, not days since the last send: a daily schedule never
// goes three days without sending (#763).
const REPLY_SETTLE_DAYS = 3
const MIN_SETTLED_SENDS = 30

export type DailyActivity = { date: string; sent: number; responses: number }

export type RespondedMessage = {
  id: number
  channel: Channel
  subject: string | null
  body: string
  sentiment: Sentiment
  responseType: ResponseType
}

export type NoResponseMessage = {
  id: number
  channel: Channel
  subject: string | null
  body: string
}

export type ProjectStatsResult = {
  metrics: EvaluationMetrics
  respondedMessages: RespondedMessage[]
  noResponseSample: NoResponseMessage[]
  dataSufficiency: {
    sufficient: boolean
    totalSent: number
    settledSent: number
  }
  dailyActivity: DailyActivity[]
}

// The tick decides on the VariantStat part; the screens also show the reactions.
type VariantTally = VariantStat & Pick<ReactionTotals, 'positive' | 'interested'>

export async function getVariantStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
  // Tick path passes true so a forgetting window (if configured) narrows the bandit's
  // view to recent data; the all-history display path (getProjectStats) leaves it false.
  applyLookback = false,
): Promise<VariantTally[]> {
  const lookbackDays =
    applyLookback && config.rewardLookbackDays !== undefined
      ? config.rewardWindowDays + config.rewardLookbackDays
      : undefined
  const epoch = applyLookback ? config.measurementsSince : undefined
  const window = and(
    isNotNull(outreachLogs.variantId),
    lt(outreachLogs.sentAt, daysAgo(config.rewardWindowDays)),
    lookbackDays === undefined ? undefined : gte(outreachLogs.sentAt, daysAgo(lookbackDays)),
    epoch === undefined ? undefined : gte(outreachLogs.sentAt, dayStart(epoch)),
  )

  const [totals, replied, reacted] = await Promise.all([
    db.select({ variantId: outreachLogs.variantId, total: count() })
      .from(outreachLogs)
      .where(sentBy(projectId, window))
      .groupBy(outreachLogs.variantId)
      .orderBy(outreachLogs.variantId),
    // Distinct sends, so a thread of two replies stays one.
    db.select({ variantId: outreachLogs.variantId, responses: countDistinct(outreachLogs.id) })
      .from(outreachLogs)
      .innerJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
      .where(and(sentBy(projectId, window), notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES])))
      .groupBy(outreachLogs.variantId),
    reactedSends(db, projectId, window),
  ])
  const responsesBy = new Map(replied.map((r) => [r.variantId, r.responses]))
  const reactions = reactionsBy(reacted, (r) => r.variantId, config.reward)
  return totals.flatMap(({ variantId, total }) => {
    if (variantId === null) return []
    const r = reactions.get(variantId)
    return [{
      variantId,
      total,
      responses: responsesBy.get(variantId) ?? 0,
      rewardSum: r?.rewardSum ?? 0,
      positive: r?.positive ?? 0,
      interested: r?.interested ?? 0,
    }]
  })
}

export async function getChannelStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
): Promise<ChannelFineStat[]> {
  // Tick-path only — the epoch always applies so channel affinity re-baselines
  // with the other lever aggregates.
  const epoch = config.measurementsSince
  const window = and(
    lt(outreachLogs.sentAt, daysAgo(config.rewardWindowDays)),
    epoch === undefined ? undefined : gte(outreachLogs.sentAt, dayStart(epoch)),
  )
  const keyOf = (channel: Channel, industry: string | null): string => JSON.stringify([channel, industry])

  const [totals, reacted] = await Promise.all([
    db.select({ channel: outreachLogs.channel, industry: prospects.industry, total: count() })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, window))
      .groupBy(outreachLogs.channel, prospects.industry),
    reactedSends(db, projectId, window),
  ])
  const rewards = reactionsBy(reacted, (r) => keyOf(r.channel, r.industry), config.reward)
  const byBucket = new Map<string, ChannelFineStat>()
  for (const row of totals) {
    const industry = industryBucket(row.industry)
    const key = keyOf(row.channel, industry)
    const held = byBucket.get(key)
    if (held) held.total += row.total
    else byBucket.set(key, { channel: row.channel, industry, total: row.total, rewardSum: rewards.get(key)?.rewardSum ?? 0 })
  }
  return Array.from(byBucket.values())
}

// Bounced sends are excluded from denominator AND rewards: for targeting a
// bounce is source data-quality, not segment disinterest. (The message bandit
// keeps them — variant and bounce are uncorrelated there.)
export async function getTargetingStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
  applyLookback = false,
): Promise<TargetingStats> {
  const lookbackDays =
    applyLookback && config.rewardLookbackDays !== undefined
      ? config.rewardWindowDays + config.rewardLookbackDays
      : undefined
  const epoch = applyLookback ? config.measurementsSince : undefined
  const window = and(
    lt(outreachLogs.sentAt, daysAgo(config.rewardWindowDays)),
    lookbackDays === undefined ? undefined : gte(outreachLogs.sentAt, daysAgo(lookbackDays)),
    epoch === undefined ? undefined : gte(outreachLogs.sentAt, dayStart(epoch)),
    not(bounced(db)),
  )
  const [industryRows, bandRows, countryRows, strategyRows, reacted] = await Promise.all([
    db.select({ industry: prospects.industry, total: count() })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, window))
      .groupBy(prospects.industry),
    db.select({ employeeBand: organizations.employeeBand, total: count() })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(sentBy(projectId, window))
      .groupBy(organizations.employeeBand),
    db.select({ prospectCountry: prospects.country, organizationCountry: organizations.country, total: count() })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(sentBy(projectId, window))
      .groupBy(prospects.country, organizations.country),
    db.select({ strategy: prospects.discoveryStrategy, total: count() })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, window))
      .groupBy(prospects.discoveryStrategy),
    reactedSends(db, projectId, window),
  ])
  const axis = (totals: Map<string | null, number>, key: (r: ReactedSend) => string | null): TargetingAxisStat[] => {
    const rewards = reactionsBy(reacted, key, config.reward)
    return Array.from(totals, ([value, total]) => ({ value, total, rewardSum: rewards.get(value)?.rewardSum ?? 0 })).sort((a, b) => {
      if (a.value === null) return b.value === null ? 0 : 1
      if (b.value === null) return -1
      return a.value.localeCompare(b.value)
    })
  }

  const industryFine = axis(foldCounts(industryRows, (r) => industryBucket(r.industry), (r) => r.total), (r) => r.industry)
  const coarseAgg = new Map<CoarseIndustry, TargetingAxisStat>()
  for (const stat of industryFine) {
    const bucket = coarseIndustry(stat.value)
    const entry = coarseAgg.get(bucket) ?? { value: bucket, total: 0, rewardSum: 0 }
    entry.total += stat.total
    entry.rewardSum += stat.rewardSum
    coarseAgg.set(bucket, entry)
  }

  return {
    industry: Array.from(coarseAgg.values()).sort((a, b) => (a.value ?? '').localeCompare(b.value ?? '')),
    employeeBand: axis(foldCounts(bandRows, (r) => r.employeeBand, (r) => r.total), (r) => r.employeeBand),
    country: axis(foldCounts(countryRows, (r) => countryBucket(r.prospectCountry, r.organizationCountry), (r) => r.total), (r) => r.country),
    discoveryStrategy: axis(foldCounts(strategyRows, (r) => r.strategy, (r) => r.total), (r) => r.strategy),
  }
}

// Windowed by futilityLookbackDays (deliberately not rewardLookbackDays —
// the bandit keeps all history) so the verdict self-clears after a repair.
// `engaged` counts sends that drew interest, not the signals themselves, so it
// stays ≤ sends for the Beta posterior.
export async function getFutilityStats(
  db: Db,
  projectId: ProjectId,
  config: LeverConfig,
): Promise<{ sends: number; engaged: number }> {
  const SENT: OutreachStatus = 'sent'
  const EMAIL: Channel = 'email'
  const matureBefore = sql`now() - make_interval(days => ${config.rewardWindowDays})`
  // Same band shape as the variant queries: sent_at ∈ [now−W−F, now−W).
  const windowDays = config.rewardWindowDays + config.futilityLookbackDays
  const epoch = config.measurementsSince
  const since = epoch === undefined ? sql`` : sql` AND ol.sent_at >= ((${epoch}::date)::timestamp AT TIME ZONE 'UTC')`
  const rows = Array.from(
    await db.execute<{ sends: string | number; engaged: string | number }>(sql`
      SELECT
        COUNT(*)::int AS sends,
        COUNT(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM responses r WHERE r.outreach_log_id = ol.id
            AND r.response_type NOT IN ('bounce', 'auto_reply')
        ) OR EXISTS (
          SELECT 1 FROM inquiry_sessions s WHERE s.outreach_log_id = ol.id AND ${REWARDED_INQUIRY}
        ))::int AS engaged
      FROM outreach_logs ol
      WHERE ol.project_id = ${projectId} AND ol.status = ${SENT} AND ol.channel = ${EMAIL}
        AND ol.sent_at < ${matureBefore}
        AND ol.sent_at >= now() - make_interval(days => ${windowDays})${since}
        AND NOT EXISTS (SELECT 1 FROM responses rb WHERE rb.outreach_log_id = ol.id AND rb.response_type = 'bounce')
    `),
  )
  return { sends: Number(rows[0]?.sends ?? 0), engaged: Number(rows[0]?.engaged ?? 0) }
}

export async function getProjectStats(
  db: Db,
  tenantId: TenantId,
  projectRef: ProjectRef,
): Promise<ServiceResult<ProjectStatsResult>> {
  const resolved = await resolveProject(db, tenantId, projectRef)
  if (!resolved.ok) return resolved
  const projectId = resolved.value

  const config = await loadLeverConfig(db, projectId)
  const mature = lt(outreachLogs.sentAt, daysAgo(config.rewardWindowDays))
  // A bounce binds only to a send whose Message-ID we generated; a form or SNS send cannot bounce.
  const threadable = and(eq(outreachLogs.channel, 'email'), isNotNull(outreachLogs.messageId))
  const countable = notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES])
  const bounce = eq(responses.responseType, 'bounce')
  // A send joins one row per response (no unique on outreach_log_id), so every count is of distinct sends.
  const sends = (filter?: SQL) =>
    filter === undefined ? countDistinct(outreachLogs.id) : sql<number>`count(distinct ${outreachLogs.id}) filter (where ${filter})`.mapWith(Number)
  const axisCounts = { total: sends(), responses: sends(countable), bounces: sends(and(bounce, threadable)), bounceEligible: sends(threadable) }
  const withResponses = eq(responses.outreachLogId, outreachLogs.id)
  const withProspect = eq(prospects.id, outreachLogs.prospectId)
  const withOrganization = eq(organizations.id, prospects.organizationId)
  // Midnight UTC 29 days ago, so the UTC-date buckets number exactly 30 (today
  // and the previous 29) instead of a rolling instant straddling 31 dates.
  const trendSince = sql`(date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days') AT TIME ZONE 'UTC'`
  // By UTC day, to match the UTC-midnight quota window.
  const sentDay = sql<string>`(${outreachLogs.sentAt} AT TIME ZONE 'UTC')::date::text`
  const receivedDay = sql<string>`(${responses.receivedAt} AT TIME ZONE 'UTC')::date::text`

  const [
    channelCountRows, [responseCounts], sentimentRows, priorityRows, statusRows, channelRows, channelIndustryRows,
    strategyRows, industryRows, sizeRows, countryRows, respondedRows, noResponseRows, [sentCounts],
    inquiryRows, dailySentRows, dailyResponseRows, variantMetaRows, variantStats, reactedAll, reactedMature,
  ] = await Promise.all([
    // Confirmed activity only: a queued draft or a stuck pre_send allocation would skew the mix.
    db.select({ channel: outreachLogs.channel, count: count() })
      .from(outreachLogs)
      .where(and(eq(outreachLogs.projectId, projectId), inArray(outreachLogs.status, ['sent', 'failed'])))
      .groupBy(outreachLogs.channel),
    db.select({ totalResponses: count(responses.id), uniqueResponders: countDistinct(outreachLogs.prospectId) })
      .from(responses).innerJoin(outreachLogs, withResponses)
      .where(eq(outreachLogs.projectId, projectId)),
    db.select({ sentiment: responses.sentiment, responseType: responses.responseType, count: count() })
      .from(responses).innerJoin(outreachLogs, withResponses)
      .where(eq(outreachLogs.projectId, projectId))
      .groupBy(responses.sentiment, responses.responseType),
    db.select({ priority: projectProspects.priority, total: sends(), responses: sends(countable) })
      .from(projectProspects)
      .leftJoin(outreachLogs, and(
        eq(outreachLogs.projectId, projectProspects.projectId),
        eq(outreachLogs.prospectId, projectProspects.prospectId),
        eq(outreachLogs.status, 'sent'),
      ))
      .leftJoin(responses, withResponses)
      .where(eq(projectProspects.projectId, projectId))
      .groupBy(projectProspects.priority)
      .orderBy(projectProspects.priority),
    db.select({ status: projectProspects.status, count: count() })
      .from(projectProspects).innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .where(and(eq(projectProspects.projectId, projectId), projectTargetExpr))
      .groupBy(projectProspects.status),
    db.select({ channel: outreachLogs.channel, total: sends(), responses: sends(countable) })
      .from(outreachLogs).leftJoin(responses, withResponses)
      .where(sentBy(projectId, undefined))
      .groupBy(outreachLogs.channel),
    db.select({ channel: outreachLogs.channel, industry: prospects.industry, total: sends(), responses: sends(countable) })
      .from(outreachLogs).innerJoin(prospects, withProspect).leftJoin(responses, withResponses)
      .where(sentBy(projectId, undefined))
      .groupBy(outreachLogs.channel, prospects.industry),
    // Replies count mature sends, like the axes below; bounces span all sends,
    // so the early source-quality read does not lag the maturity window.
    db.select({
      strategy: prospects.discoveryStrategy,
      total: sends(mature),
      responses: sends(and(countable, mature)),
      bounces: axisCounts.bounces,
      bounceEligible: axisCounts.bounceEligible,
    })
      .from(outreachLogs).innerJoin(prospects, withProspect).leftJoin(responses, withResponses)
      .where(sentBy(projectId, undefined))
      .groupBy(prospects.discoveryStrategy),
    db.select({ industry: prospects.industry, ...axisCounts })
      .from(outreachLogs).innerJoin(prospects, withProspect).leftJoin(responses, withResponses)
      .where(sentBy(projectId, mature))
      .groupBy(prospects.industry),
    db.select({ employeeBand: organizations.employeeBand, ...axisCounts })
      .from(outreachLogs).innerJoin(prospects, withProspect).innerJoin(organizations, withOrganization).leftJoin(responses, withResponses)
      .where(sentBy(projectId, mature))
      .groupBy(organizations.employeeBand),
    db.select({ prospectCountry: prospects.country, organizationCountry: organizations.country, ...axisCounts })
      .from(outreachLogs).innerJoin(prospects, withProspect).innerJoin(organizations, withOrganization).leftJoin(responses, withResponses)
      .where(sentBy(projectId, mature))
      .groupBy(prospects.country, organizations.country),
    db.select({
      id: outreachLogs.id,
      channel: outreachLogs.channel,
      subject: outreachLogs.subject,
      body: outreachLogs.body,
      sentiment: responses.sentiment,
      responseType: responses.responseType,
    })
      .from(responses).innerJoin(outreachLogs, withResponses)
      .where(eq(outreachLogs.projectId, projectId)),
    db.select({ id: outreachLogs.id, channel: outreachLogs.channel, subject: outreachLogs.subject, body: outreachLogs.body })
      .from(outreachLogs)
      .where(sentBy(projectId, not(exists(db.select({ id: responses.id }).from(responses).where(withResponses)))))
      .orderBy(desc(outreachLogs.sentAt))
      .limit(10),
    db.select({ totalSent: sends(), settledSent: sends(lt(outreachLogs.sentAt, daysAgo(REPLY_SETTLE_DAYS))), matureSent: sends(mature) })
      .from(outreachLogs)
      .where(sentBy(projectId, undefined)),
    db.select({ outcome: inquirySessions.outcome, count: count() })
      .from(inquirySessions).innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
      .where(eq(outreachLogs.projectId, projectId))
      .groupBy(inquirySessions.outcome),
    db.select({ day: sentDay, count: count() })
      .from(outreachLogs)
      .where(sentBy(projectId, gte(outreachLogs.sentAt, trendSince)))
      .groupBy(sentDay),
    db.select({ day: receivedDay, count: count() })
      .from(responses).innerJoin(outreachLogs, withResponses)
      .where(and(eq(outreachLogs.projectId, projectId), gte(responses.receivedAt, trendSince)))
      .groupBy(receivedDay),
    db.select({ variantId: messageVariants.variantId, label: messageVariants.label, archivedAt: messageVariants.archivedAt })
      .from(messageVariants)
      .where(eq(messageVariants.projectId, projectId)),
    getVariantStats(db, projectId, config),
    reactedSends(db, projectId, undefined),
    reactedSends(db, projectId, mature),
  ])

  const totalSent = sentCounts?.totalSent ?? 0
  const settledSent = sentCounts?.settledSent ?? 0
  const matureSent = sentCounts?.matureSent ?? 0

  const rates = (total: number, { positive, interested }: Pick<ReactionTotals, 'positive' | 'interested'> = { positive: 0, interested: 0 }) => ({
    positive,
    positiveRate: percentOf(positive, total),
    interested,
    interestedRate: percentOf(interested, total),
  })
  const replies = (total: number, responded: number) => ({ total, responses: responded, rate: percentOf(responded, total) })
  const axisBucket = (c: SendCounts) => ({ ...replies(c.total, c.responses), bounces: c.bounces, bounceRate: percentOf(c.bounces, c.bounceEligible) })
  const bySends = (a: { total: number; rate: number }, b: { total: number; rate: number }) => b.total - a.total || b.rate - a.rate

  // Seed every outcome at 0 so the shape is stable when a project has no
  // sessions for an outcome.
  const inquiryOutcomeCounts = Object.fromEntries(INQUIRY_OUTCOMES.map((o) => [o, 0])) as Record<InquiryOutcome, number>
  for (const row of inquiryRows) inquiryOutcomeCounts[row.outcome] = row.count

  const variantMeta = new Map(variantMetaRows.map((r) => [r.variantId, { label: r.label, active: r.archivedAt === null }]))

  const channelIndustryKey = (channel: Channel, industry: string | null): string => JSON.stringify([channel, industry])
  const channelIndustry = new Map<string, { channel: Channel; industry: string | null; total: number; responses: number }>()
  for (const row of channelIndustryRows) {
    const industry = industryBucket(row.industry)
    const key = channelIndustryKey(row.channel, industry)
    const held = channelIndustry.get(key)
    if (held) {
      held.total += row.total
      held.responses += row.responses
    } else channelIndustry.set(key, { channel: row.channel, industry, total: row.total, responses: row.responses })
  }

  const priorityKey = (priority: number | null): string | null => (priority === null ? null : String(priority))
  const priorityReactions = reactionsBy(reactedAll, (r) => priorityKey(r.priority), config.reward)
  const channelReactions = reactionsBy(reactedAll, (r) => r.channel, config.reward)
  const channelIndustryReactions = reactionsBy(reactedAll, (r) => channelIndustryKey(r.channel, r.industry), config.reward)
  const strategyReactions = reactionsBy(reactedMature, (r) => r.strategy, config.reward)
  const industryReactions = reactionsBy(reactedMature, (r) => coarseIndustry(r.industry), config.reward)
  const sizeReactions = reactionsBy(reactedMature, (r) => r.employeeBand, config.reward)
  const countryReactions = reactionsBy(reactedMature, (r) => r.country, config.reward)

  const metrics: EvaluationMetrics = {
    totalOutreach: totalSent,
    kpi: { matureSent, ...rates(matureSent, reactionsBy(reactedMature, () => null, config.reward).get(null)) },
    channelCounts: channelCountRows,
    responseCounts: { totalResponses: responseCounts?.totalResponses ?? 0, uniqueResponders: responseCounts?.uniqueResponders ?? 0 },
    sentimentBreakdown: sentimentRows,
    priorityResponseRate: priorityRows.map((r) => ({
      priority: r.priority,
      ...replies(r.total, r.responses),
      ...rates(r.total, priorityReactions.get(priorityKey(r.priority))),
    })),
    statusCounts: statusRows,
    channelResponseRate: channelRows.map((r) => ({
      channel: r.channel,
      ...replies(r.total, r.responses),
      ...rates(r.total, channelReactions.get(r.channel)),
    })),
    channelByIndustry: Array.from(channelIndustry, ([key, r]) => ({
      channel: r.channel,
      industry: r.industry,
      ...replies(r.total, r.responses),
      ...rates(r.total, channelIndustryReactions.get(key)),
    })).sort(bySends),
    discoveryStrategyResponseRate: strategyRows
      .map((r) => ({ strategy: r.strategy, ...axisBucket(r), ...rates(r.total, strategyReactions.get(r.strategy)) }))
      .sort(bySends),
    industryResponseRate: Array.from(foldSends(industryRows, (r) => coarseIndustry(industryBucket(r.industry))), ([industry, c]) => ({
      industry,
      ...axisBucket(c),
      ...rates(c.total, industryReactions.get(industry)),
    })).sort(bySends),
    sizeResponseRate: sizeRows
      .map((r) => ({ employeeBand: r.employeeBand, ...axisBucket(r), ...rates(r.total, sizeReactions.get(r.employeeBand)) }))
      .sort(bySends),
    countryResponseRate: Array.from(foldSends(countryRows, (r) => countryBucket(r.prospectCountry, r.organizationCountry)), ([country, c]) => ({
      country,
      ...axisBucket(c),
      ...rates(c.total, countryReactions.get(country)),
    })).sort(bySends),
    variantResponseRate: variantStats.map((v) => ({
      variantId: v.variantId,
      label: variantMeta.get(v.variantId)?.label ?? null,
      active: variantMeta.get(v.variantId)?.active ?? false,
      ...replies(v.total, v.responses),
      meanReward: v.total === 0 ? 0 : Math.round((v.rewardSum / v.total) * 1000) / 1000,
      ...rates(v.total, v),
    })),
    inquiryOutcomeCounts,
  }

  // Zero-activity days are omitted to keep the table compact.
  const dailyMap = new Map<string, DailyActivity>()
  for (const row of dailySentRows) dailyMap.set(row.day, { date: row.day, sent: row.count, responses: 0 })
  for (const row of dailyResponseRows) {
    const entry = dailyMap.get(row.day) ?? { date: row.day, sent: 0, responses: 0 }
    entry.responses = row.count
    dailyMap.set(row.day, entry)
  }
  const dailyActivity = Array.from(dailyMap.values()).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  return ok({
    metrics,
    respondedMessages: respondedRows,
    noResponseSample: noResponseRows,
    dataSufficiency: {
      sufficient: settledSent >= MIN_SETTLED_SENDS,
      totalSent,
      settledSent,
    },
    dailyActivity,
  })
}

export type ReactionCounts = { n: number; positive: number; interested: number }

// 'lost' / 'rotated' when the tick archived the option (its lever_decisions
// row that day); 'other' when evaluate or the person did.
export type Archival = { on: string; reason: 'lost' | 'rotated' | 'other' }

export type VariantEvidence = ReactionCounts & {
  variantId: string
  addedOn: string
  label: string | null
  subjectPattern: string
  bodyApproach: string | null
  archived: Archival | null
}

export type StrategyEvidence = ReactionCounts & {
  slug: string
  addedOn: string
  approach: string
  // Threadable email sends only: a form or SNS send cannot bounce.
  bounced: number
  bounceEligible: number
  archived: Archival | null
}

export type EvidenceAxis = 'industry' | 'size' | 'country' | 'channel' | 'priority'
export type AxisBucket = ReactionCounts & { value: string | null }

export type RepliedSend = {
  lastReplyOn: string
  level: ReactionLevel
  variantId: string | null
  strategy: string | null
  subject: string | null
  // Our message only where they showed interest: what worked is in it, while
  // a No gives its reason in their own words.
  ours: string | null
  theirs: string
}

// What evaluate reads (#793): the frame's sends only, every list bounded, each
// fact once. `n` counts mature sends (older than the reward window).
export type ProposeEvidence = {
  frameStart: string | null
  sufficient: boolean
  settled: number
  kpi: ReactionCounts
  variants: VariantEvidence[]
  strategies: StrategyEvidence[]
  axes: Record<EvidenceAxis, AxisBucket[]>
  repliedSends: RepliedSend[]
  inquiryOutcomes: Record<InquiryOutcome, number>
}

const ARCHIVED_OPTIONS_SHOWN = 10
const REPLIED_SENDS_SHOWN = 30
const EVIDENCE_TEXT_CHARS = 1500

export async function getProposeEvidence(db: Db, projectId: ProjectId, config: LeverConfig): Promise<ProposeEvidence> {
  const epoch = config.measurementsSince
  const frameStart = epoch === undefined ? undefined : dayStart(epoch)
  const inFrame = frameStart === undefined ? undefined : gte(outreachLogs.sentAt, frameStart)
  const mature = and(lt(outreachLogs.sentAt, daysAgo(config.rewardWindowDays)), inFrame)
  const threadable = and(eq(outreachLogs.channel, 'email'), isNotNull(outreachLogs.messageId), inFrame)
  const countable = notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES])
  const archivedInFrame = (column: typeof messageVariants.archivedAt | typeof discoveryStrategies.archivedAt) =>
    and(isNotNull(column), frameStart === undefined ? undefined : gte(column, frameStart))
  const variantCols = { id: messageVariants.variantId, label: messageVariants.label, subjectPattern: messageVariants.subjectPattern, bodyApproach: messageVariants.bodyApproach, createdAt: messageVariants.createdAt, archivedAt: messageVariants.archivedAt }
  const strategyCols = { id: discoveryStrategies.slug, approach: discoveryStrategies.approach, createdAt: discoveryStrategies.createdAt, archivedAt: discoveryStrategies.archivedAt }

  const [
    industryRows, sizeRows, countryRows, channelRows, priorityRows, variantRows, strategyRows, reacted,
    bouncedRows, eligibleRows, activeVariants, archivedVariants, activeStrategies, archivedStrategies,
    recent, inquiryRows, [settled],
  ] = await Promise.all([
    db.select({ industry: prospects.industry, n: count() })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, mature)).groupBy(prospects.industry),
    db.select({ size: organizations.employeeBand, n: count() })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId)).innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(sentBy(projectId, mature)).groupBy(organizations.employeeBand),
    db.select({ prospectCountry: prospects.country, organizationCountry: organizations.country, n: count() })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId)).innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .where(sentBy(projectId, mature)).groupBy(prospects.country, organizations.country),
    db.select({ channel: outreachLogs.channel, n: count() })
      .from(outreachLogs)
      .where(sentBy(projectId, mature)).groupBy(outreachLogs.channel),
    db.select({ priority: projectProspects.priority, n: count() })
      .from(outreachLogs).leftJoin(projectProspects, and(eq(projectProspects.projectId, outreachLogs.projectId), eq(projectProspects.prospectId, outreachLogs.prospectId)))
      .where(sentBy(projectId, mature)).groupBy(projectProspects.priority),
    db.select({ variantId: outreachLogs.variantId, n: count() })
      .from(outreachLogs)
      .where(sentBy(projectId, mature)).groupBy(outreachLogs.variantId),
    db.select({ strategy: prospects.discoveryStrategy, n: count() })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, mature)).groupBy(prospects.discoveryStrategy),
    reactedSends(db, projectId, mature),
    db.select({ strategy: prospects.discoveryStrategy, n: countDistinct(outreachLogs.id) })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId)).innerJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
      .where(and(sentBy(projectId, threadable), eq(responses.responseType, 'bounce'))).groupBy(prospects.discoveryStrategy),
    db.select({ strategy: prospects.discoveryStrategy, n: count() })
      .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .where(sentBy(projectId, threadable)).groupBy(prospects.discoveryStrategy),
    db.select(variantCols).from(messageVariants)
      .where(and(eq(messageVariants.projectId, projectId), isNull(messageVariants.archivedAt)))
      .orderBy(asc(messageVariants.variantId)),
    db.select(variantCols).from(messageVariants)
      .where(and(eq(messageVariants.projectId, projectId), archivedInFrame(messageVariants.archivedAt)))
      .orderBy(desc(messageVariants.archivedAt)).limit(ARCHIVED_OPTIONS_SHOWN),
    db.select(strategyCols).from(discoveryStrategies)
      .where(and(eq(discoveryStrategies.projectId, projectId), isNull(discoveryStrategies.archivedAt)))
      .orderBy(asc(discoveryStrategies.slug)),
    db.select(strategyCols).from(discoveryStrategies)
      .where(and(eq(discoveryStrategies.projectId, projectId), archivedInFrame(discoveryStrategies.archivedAt)))
      .orderBy(desc(discoveryStrategies.archivedAt)).limit(ARCHIVED_OPTIONS_SHOWN),
    db.select({ outreachLogId: responses.outreachLogId, last: max(responses.receivedAt) })
      .from(responses).innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(sentBy(projectId, inFrame), countable))
      .groupBy(responses.outreachLogId).orderBy(desc(max(responses.receivedAt)), responses.outreachLogId).limit(REPLIED_SENDS_SHOWN),
    db.select({ outcome: inquirySessions.outcome, n: count() })
      .from(inquirySessions).innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
      .where(sentBy(projectId, inFrame)).groupBy(inquirySessions.outcome),
    db.select({ n: count() }).from(outreachLogs)
      .where(sentBy(projectId, and(lt(outreachLogs.sentAt, daysAgo(REPLY_SETTLE_DAYS)), inFrame))),
  ])

  const dayOf = (at: Date): string => at.toISOString().slice(0, 10)
  const recentIds = recent.map((r) => r.outreachLogId)
  const archiveDays = [...archivedVariants, ...archivedStrategies].map((o) => dayOf(o.archivedAt!))
  const [replyRows, sessionRows, tickRows] = await Promise.all([
    recentIds.length === 0
      ? []
      : db.select({
          outreachLogId: outreachLogs.id,
          variantId: outreachLogs.variantId,
          strategy: prospects.discoveryStrategy,
          subject: outreachLogs.subject,
          body: outreachLogs.body,
          responseType: responses.responseType,
          sentiment: responses.sentiment,
          content: responses.content,
        })
          .from(outreachLogs).innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId)).innerJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
          .where(and(inArray(outreachLogs.id, recentIds), countable))
          .orderBy(asc(responses.receivedAt)),
    // The level is the send's, as the KPI counts it: a signup after a No is positive.
    recentIds.length === 0
      ? []
      : db.select({ outreachLogId: inquirySessions.outreachLogId, outcome: inquirySessions.outcome })
          .from(inquirySessions).where(inArray(inquirySessions.outreachLogId, recentIds)),
    // Only the days the listed options were archived: the tick's row that day says why.
    archiveDays.length === 0
      ? []
      : db.select({ cycleDate: leverDecisions.cycleDate, decision: leverDecisions.decision })
          .from(leverDecisions).where(and(eq(leverDecisions.projectId, projectId), inArray(leverDecisions.cycleDate, archiveDays))),
  ])

  const withReactions = (n: number, t: ReactionTotals | undefined): ReactionCounts => ({ n, positive: t?.positive ?? 0, interested: t?.interested ?? 0 })
  const axisBuckets = (totals: Map<string | null, number>, key: (r: ReactedSend) => string | null): AxisBucket[] => {
    const reactions = reactionsBy(reacted, key, config.reward)
    return Array.from(totals, ([value, n]) => ({ value, ...withReactions(n, reactions.get(value)) })).sort(
      (a, b) => b.n - a.n || (a.value ?? '').localeCompare(b.value ?? ''),
    )
  }
  const priorityBucket = (priority: number | null): string | null => (priority === null ? null : String(priority))

  const archival = (id: string, at: Date | null, layer: 'variant' | 'strategy'): Archival | null => {
    if (at === null) return null
    const on = dayOf(at)
    const tick = tickRows.find((row) => row.cycleDate === on)?.decision
    if (layer === 'variant') {
      const hit = tick?.subject.archived.find((a) => a.variantId === id)
      return { on, reason: hit ? (hit.reason === 'stagnation' ? 'rotated' : 'lost') : 'other' }
    }
    return { on, reason: tick?.discovery?.archived.some((a) => a.slug === id) ? 'lost' : 'other' }
  }

  const variantN = new Map(variantRows.map((r) => [r.variantId, r.n]))
  const variantReactions = reactionsBy(reacted, (r) => r.variantId, config.reward)
  const strategyN = new Map(strategyRows.map((r) => [r.strategy, r.n]))
  const strategyReactions = reactionsBy(reacted, (r) => r.strategy, config.reward)
  const bouncedBy = new Map(bouncedRows.map((r) => [r.strategy, r.n]))
  const eligibleBy = new Map(eligibleRows.map((r) => [r.strategy, r.n]))

  const reactionsOf = new Map<number, Reaction[]>()
  const textsOf = new Map<number, string[]>()
  const sendOf = new Map<number, (typeof replyRows)[number]>()
  for (const row of replyRows) {
    sendOf.set(row.outreachLogId, row)
    reactionsOf.set(row.outreachLogId, [...(reactionsOf.get(row.outreachLogId) ?? []), { kind: 'reply', responseType: row.responseType, sentiment: row.sentiment }])
    const text = unquotedText(row.content)
    if (text !== '') textsOf.set(row.outreachLogId, [...(textsOf.get(row.outreachLogId) ?? []), text])
  }
  for (const s of sessionRows) reactionsOf.get(s.outreachLogId)?.push({ kind: 'inquiry', outcome: s.outcome })
  const repliedSends: RepliedSend[] = recent.flatMap(({ outreachLogId, last }) => {
    const send = sendOf.get(outreachLogId)
    const texts = textsOf.get(outreachLogId) ?? []
    if (send === undefined || last === null || texts.length === 0) return []
    const { level } = sendReaction(reactionsOf.get(outreachLogId) ?? [])
    return [{
      lastReplyOn: dayOf(last),
      level,
      variantId: send.variantId,
      strategy: send.strategy,
      subject: send.subject,
      ours: level === 'none' ? null : send.body.slice(0, EVIDENCE_TEXT_CHARS),
      theirs: texts.join('\n---\n').slice(0, EVIDENCE_TEXT_CHARS),
    }]
  })

  const inquiryOutcomes = Object.fromEntries(INQUIRY_OUTCOMES.map((o) => [o, 0])) as Record<InquiryOutcome, number>
  for (const row of inquiryRows) inquiryOutcomes[row.outcome] = row.n

  const kpiN = channelRows.reduce((sum, r) => sum + r.n, 0)
  const settledN = settled?.n ?? 0
  return {
    frameStart: epoch ?? null,
    sufficient: settledN >= MIN_SETTLED_SENDS,
    settled: settledN,
    kpi: withReactions(kpiN, reactionsBy(reacted, () => null, config.reward).get(null)),
    variants: [...activeVariants, ...archivedVariants].map((v) => ({
      variantId: v.id,
      addedOn: dayOf(v.createdAt),
      label: v.label,
      subjectPattern: v.subjectPattern,
      bodyApproach: v.bodyApproach,
      archived: archival(v.id, v.archivedAt, 'variant'),
      ...withReactions(variantN.get(v.id) ?? 0, variantReactions.get(v.id)),
    })),
    strategies: [...activeStrategies, ...archivedStrategies].map((st) => ({
      slug: st.id,
      addedOn: dayOf(st.createdAt),
      approach: st.approach,
      bounced: bouncedBy.get(st.id) ?? 0,
      bounceEligible: eligibleBy.get(st.id) ?? 0,
      archived: archival(st.id, st.archivedAt, 'strategy'),
      ...withReactions(strategyN.get(st.id) ?? 0, strategyReactions.get(st.id)),
    })),
    axes: {
      industry: axisBuckets(foldCounts(industryRows, (r) => coarseIndustry(industryBucket(r.industry)), (r) => r.n), (r) => coarseIndustry(r.industry)),
      size: axisBuckets(foldCounts(sizeRows, (r) => r.size, (r) => r.n), (r) => r.employeeBand),
      country: axisBuckets(foldCounts(countryRows, (r) => countryBucket(r.prospectCountry, r.organizationCountry), (r) => r.n), (r) => r.country),
      channel: axisBuckets(foldCounts(channelRows, (r) => r.channel, (r) => r.n), (r) => r.channel),
      priority: axisBuckets(foldCounts(priorityRows, (r) => priorityBucket(r.priority), (r) => r.n), (r) => priorityBucket(r.priority)),
    },
    repliedSends,
    inquiryOutcomes,
  }
}

export async function loadActiveVariantIds(db: Db, projectId: ProjectId): Promise<string[]> {
  const rows = await db
    .select({ variantId: messageVariants.variantId })
    .from(messageVariants)
    .where(and(eq(messageVariants.projectId, projectId), isNull(messageVariants.archivedAt)))
    .orderBy(asc(messageVariants.variantId))
  return rows.map((r) => r.variantId)
}

// A stagnation rotation frees a slot for a fresh angle; it stays "unfulfilled"
// until either a new variant row is created after it (evaluate seeds fresh
// slugs, so createdAt marks that) or the active pool grows back past its
// post-rotation size (a user un-archiving an arm refills the slot without a
// new row — the system must not wedge on that override). A later archive can
// flip a count-fulfilled rotation back to unfulfilled; that fails safe by
// re-raising replenishment. While unfulfilled, no further rotation fires and
// needsReplenishment stays raised even at targetActiveArms.
export async function hasUnfulfilledRotation(
  db: Db,
  projectId: ProjectId,
  activeCount: number,
): Promise<boolean> {
  const [lastRotation] = await db
    .select({ createdAt: leverDecisions.createdAt, decision: leverDecisions.decision })
    .from(leverDecisions)
    .where(and(
      eq(leverDecisions.projectId, projectId),
      sql`${leverDecisions.decision} @> ${JSON.stringify({ subject: { archived: [{ reason: 'stagnation' }] } })}::jsonb`,
    ))
    .orderBy(desc(leverDecisions.cycleDate))
    .limit(1)
  if (!lastRotation) return false
  const postRotationCount =
    lastRotation.decision.subject.samples.length - lastRotation.decision.subject.archived.length
  if (activeCount > postRotationCount) return false
  const [fresh] = await db
    .select({ id: messageVariants.id })
    .from(messageVariants)
    .where(and(
      eq(messageVariants.projectId, projectId),
      gt(messageVariants.createdAt, lastRotation.createdAt),
    ))
    .limit(1)
  return !fresh
}

// Prior-UTC-day registration counts per strategy — the plan-compliance record
// (§ the tick journals what actually flowed in against yesterday's batchPlan).
// Derived from project_prospects.created_at × prospects.discovery_strategy,
// restricted to this project's registry (archived included — a slug planned
// yesterday may be archived today; a provenance slug carried in by a
// cross-project link is not an arm here and stays out, matching the bandit's
// registry ∩ stats rule). A persistent gap between plan and registrations
// marks a strategy the LLM cannot execute (exhausted or non-existent angle).
async function loadPriorDayRegistrations(
  db: Db,
  projectId: ProjectId,
  cycleDate: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({ slug: prospects.discoveryStrategy, count: sql<number>`COUNT(*)::int` })
    .from(projectProspects)
    .innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
    .innerJoin(discoveryStrategies, and(
      eq(discoveryStrategies.projectId, projectProspects.projectId),
      eq(discoveryStrategies.slug, prospects.discoveryStrategy),
    ))
    .where(and(
      eq(projectProspects.projectId, projectId),
      projectTargetExpr,
      isNotNull(prospects.discoveryStrategy),
      sql`${projectProspects.createdAt} >= ((${cycleDate}::date - 1)::timestamp AT TIME ZONE 'UTC')`,
      sql`${projectProspects.createdAt} < ((${cycleDate}::date)::timestamp AT TIME ZONE 'UTC')`,
    ))
    .groupBy(prospects.discoveryStrategy)
  return Object.fromEntries(rows.map((r) => [r.slug!, Number(r.count)]))
}

export async function observeTick(db: Db, projectId: ProjectId, config: LeverConfig, cycleDate: string): Promise<TickEvidence> {
  const activeIds = await loadActiveVariantIds(db, projectId)
  const statsMap = new Map((await getVariantStats(db, projectId, config, true)).map((s) => [s.variantId, s]))
  const targeting = await getTargetingStats(db, projectId, config, true)
  // A stats slug outside the active registry stays baseline-only (e.g. carried
  // in by a cross-project link).
  const activeSlugs = await getActiveStrategySlugs(db, projectId)
  const strategyStats = new Map(
    targeting.discoveryStrategy
      .filter((s): s is typeof s & { value: string } => s.value !== null)
      .map((s) => [s.value, s]),
  )
  const recent = await db
    .select({ decision: leverDecisions.decision })
    .from(leverDecisions)
    .where(eq(leverDecisions.projectId, projectId))
    .orderBy(desc(leverDecisions.cycleDate))
    .limit(config.stagnationTicks - 1)
  return {
    // Active set only → archived excluded; an active-but-unsent variant is total 0.
    // Only the VariantStat fields: the decision row records these as samples.
    variants: activeIds.map((id) => {
      const s = statsMap.get(id)
      return { variantId: id, total: s?.total ?? 0, responses: s?.responses ?? 0, rewardSum: s?.rewardSum ?? 0 }
    }),
    strategies: activeSlugs.map((slug) => ({
      armId: slug,
      total: strategyStats.get(slug)?.total ?? 0,
      rewardSum: strategyStats.get(slug)?.rewardSum ?? 0,
    })),
    channel: await getChannelStats(db, projectId, config),
    targeting,
    futility: await getFutilityStats(db, projectId, config),
    registrations: await loadPriorDayRegistrations(db, projectId, cycleDate),
    recentSubjects: recent.map((h) => h.decision.subject),
    unfulfilledRotation: await hasUnfulfilledRotation(db, projectId, activeIds.length),
  }
}
