import { and, asc, count, countDistinct, desc, eq, exists, gte, inArray, isNotNull, isNull, lt, max, ne, not, notInArray, sql, sum, type SQL } from 'drizzle-orm'
import {
  discoveryStrategies,
  INQUIRY_OUTCOMES,
  inquirySessions,
  jobs,
  leverState,
  messageVariants,
  organizations,
  OUTBOUND_CHANNELS,
  outreachLogs,
  paidCalls,
  projectProspects,
  prospects,
  responses,
  responseTypeEnum,
  sentimentEnum,
  type Channel,
  type EmployeeBand,
  type EvaluationMetrics,
  type InquiryOutcome,
  type OutboundChannel,
} from '../../db/schema'
import type { Db } from '../../db/connection'
import type { ProjectId, ProjectRef, TenantId } from '../../domain/ids'
import { NON_COUNTABLE_RESPONSE_TYPES, OBSERVED_INQUIRY_OUTCOMES, reactionTotalsByKey, REWARDED_INQUIRY_OUTCOMES, sendReaction, type Reaction, type ReactionLevel, type ReactionTotals, type RewardWeights } from '../../domain/loop/reaction'
import { evidenceBy, evidenceOf, REPLY_ARRIVAL_DAYS, type Evidence, type SendObservation } from '../../domain/loop/evidence'
import { unquotedText } from '../../domain/reply-classify'
import { primaryReasonOf } from '../../domain/rejection-feedback'
import { coarseIndustry } from '../../domain/coarse-industry'
import { percentOf } from '../../domain/dashboard'
import { type LeverConfig } from '../../domain/loop/config'
import type { ChannelFineStat, TargetingAxisStat, TargetingStats } from '../../domain/loop/allocation'
import type { TickEvidence } from '../../domain/loop/decide'
import type { ArmStat } from '../../domain/loop/bandit'
import type { FollowUpJsonOp, GroundedTextOp, PagesJsonOp } from '../llm/routes'
import { loadLeverConfig, loadProjectOutboundAllowlist } from '../project-settings'
import { ok, type ServiceResult } from '../result'
import { resolveProject } from '../projects'
import { projectTargetExpr, usableOnExpr } from '../prospects'
import { getActiveStrategySlugs } from '../discovery-strategies'
import { frameStart, frameStarts, lastArchivals, lostOptionIds, optionEntries, type OptionArchival } from './change'
import type { OptionTarget } from '../../domain/loop/change'

type ResponseType = (typeof responseTypeEnum.enumValues)[number]
type Sentiment = (typeof sentimentEnum.enumValues)[number]

// The DB clock: every query in one transaction reads the same now().
const daysAgo = (days: number): SQL => sql`now() - make_interval(days => ${days})`
const DAY_MS = 24 * 60 * 60 * 1000

// Bucket values, one definition for the send counts and the reactions alike.
const industryBucket = (raw: string | null): string | null => raw?.trim() || null
const countryBucket = (prospect: string | null, organization: string | null): string | null =>
  (prospect ?? organization)?.toUpperCase() ?? null

const sentBy = (projectId: ProjectId, where: SQL | undefined): SQL | undefined =>
  and(eq(outreachLogs.projectId, projectId), eq(outreachLogs.status, 'sent'), where)

const statedReason = sql<string | null>`${responses.rejectionFeedback}->>'primary_reason'`

const dayOf = (at: Date): string => at.toISOString().slice(0, 10)

// Every send since `since` (all of them when undefined), each with the
// attributes the loop measures by and the reactions it drew, in arrival order.
// Auto-replies say nothing about the send and are left out.
async function observeSends(db: Db, projectId: ProjectId, since: Date | undefined): Promise<SendObservation[]> {
  const window = since === undefined ? undefined : gte(outreachLogs.sentAt, since)
  const inProject = and(eq(projectProspects.projectId, outreachLogs.projectId), eq(projectProspects.prospectId, outreachLogs.prospectId))
  const [sends, replies, sessions] = await Promise.all([
    db.select({
      outreachLogId: outreachLogs.id,
      sentAt: outreachLogs.sentAt,
      variantId: outreachLogs.variantId,
      strategy: prospects.discoveryStrategy,
      channel: outreachLogs.channel,
      messageId: outreachLogs.messageId,
      industry: prospects.industry,
      employeeBand: organizations.employeeBand,
      prospectCountry: prospects.country,
      organizationCountry: organizations.country,
      priority: projectProspects.priority,
    })
      .from(outreachLogs)
      .innerJoin(prospects, eq(prospects.id, outreachLogs.prospectId))
      .innerJoin(organizations, eq(organizations.id, prospects.organizationId))
      .leftJoin(projectProspects, inProject)
      .where(sentBy(projectId, window)),
    db.select({ outreachLogId: responses.outreachLogId, responseType: responses.responseType, sentiment: responses.sentiment, reason: statedReason })
      .from(responses)
      .innerJoin(outreachLogs, eq(outreachLogs.id, responses.outreachLogId))
      .where(and(sentBy(projectId, window), ne(responses.responseType, 'auto_reply')))
      .orderBy(asc(responses.receivedAt), asc(responses.id)),
    db.select({ outreachLogId: inquirySessions.outreachLogId, outcome: inquirySessions.outcome })
      .from(inquirySessions)
      .innerJoin(outreachLogs, eq(outreachLogs.id, inquirySessions.outreachLogId))
      .where(and(sentBy(projectId, window), inArray(inquirySessions.outcome, OBSERVED_INQUIRY_OUTCOMES))),
  ])
  const reactionsOf = new Map<number, Reaction[]>()
  const push = (id: number, reaction: Reaction) => reactionsOf.set(id, [...(reactionsOf.get(id) ?? []), reaction])
  for (const r of replies) push(r.outreachLogId, { kind: 'reply', responseType: r.responseType, sentiment: r.sentiment, reason: primaryReasonOf(r.reason) })
  for (const r of sessions) push(r.outreachLogId, { kind: 'inquiry', outcome: r.outcome })
  return sends.map(({ messageId, industry, prospectCountry, organizationCountry, ...send }) => ({
    ...send,
    industry: industryBucket(industry),
    country: countryBucket(prospectCountry, organizationCountry),
    bounceable: send.channel === 'email' && messageId !== null,
    reactions: reactionsOf.get(send.outreachLogId) ?? [],
  }))
}

// The forgetting window, when configured, narrows what the options are judged on.
const recentEnough = (config: LeverConfig, now: Date) => (send: SendObservation): boolean =>
  config.rewardLookbackDays === undefined || send.sentAt.getTime() >= now.getTime() - config.rewardLookbackDays * DAY_MS

const optionOf = (target: OptionTarget) => (send: SendObservation): string | undefined =>
  (target === 'variant' ? send.variantId : send.strategy) ?? undefined

const armOf = (id: string, e: Evidence | undefined): ArmStat => ({ armId: id, total: e?.trials ?? 0, rewardSum: e?.rewardSum ?? 0 })

// Each option's evidence over all its sends, and over those since it last
// entered the active set (an option with no entry on record counts every send).
function optionEvidence(sends: readonly SendObservation[], target: OptionTarget, entries: Map<string, Date>, now: Date, weights: RewardWeights) {
  const option = optionOf(target)
  const sinceEntry = (send: SendObservation): string | undefined => {
    const id = option(send)
    const at = id === undefined ? undefined : entries.get(id)
    return at === undefined || send.sentAt >= at ? id : undefined
  }
  return { all: evidenceBy(sends, option, now, weights), sinceEntry: evidenceBy(sends, sinceEntry, now, weights) }
}

function targetingStatsOf(sends: readonly SendObservation[], now: Date, weights: RewardWeights): TargetingStats {
  const axis = <K extends string | null>(key: (send: SendObservation) => K, compare: (a: K, b: K) => number): TargetingAxisStat[] =>
    Array.from(evidenceBy(sends, key, now, weights), ([value, e]) => ({ value, total: e.trials, rewardSum: e.rewardSum })).sort((a, b) => compare(a.value, b.value))
  const nullsLast = (a: string | null, b: string | null): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a.localeCompare(b))
  return {
    industry: axis((send) => coarseIndustry(send.industry), (a, b) => (a ?? '').localeCompare(b ?? '')),
    employeeBand: axis((send) => send.employeeBand, nullsLast),
    country: axis((send) => send.country, nullsLast),
  }
}

function channelStatsOf(sends: readonly SendObservation[], now: Date, weights: RewardWeights): ChannelFineStat[] {
  const buckets = new Map<string, { channel: Channel; industry: string | null; sends: SendObservation[] }>()
  for (const send of sends) {
    const key = JSON.stringify([send.channel, send.industry])
    const bucket = buckets.get(key) ?? { channel: send.channel, industry: send.industry, sends: [] }
    bucket.sends.push(send)
    buckets.set(key, bucket)
  }
  return Array.from(buckets.values(), ({ channel, industry, sends: inBucket }) => {
    const e = evidenceOf(inBucket, now, weights)
    return { channel, industry, total: e.trials, rewardSum: e.rewardSum }
  })
}

// `engaged` counts any human reaction, a no included: the check asks whether
// mail reaches people at all.
function futilityOf(sends: readonly SendObservation[], config: LeverConfig, now: Date): { sends: number; engaged: number } {
  const since = now.getTime() - config.futilityLookbackDays * DAY_MS
  const e = evidenceOf(sends.filter((send) => send.channel === 'email' && send.sentAt.getTime() >= since), now, config.reward)
  return { sends: e.trials, engaged: e.replied }
}

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
    db.select({ ...send, responseType: responses.responseType, sentiment: responses.sentiment, reason: statedReason })
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
    ...replies.map((r) => ({ ...bucketed(r), reaction: { kind: 'reply' as const, responseType: r.responseType, sentiment: r.sentiment, reason: primaryReasonOf(r.reason) } })),
    ...sessions.map((r) => ({ ...bucketed(r), reaction: { kind: 'inquiry' as const, outcome: r.outcome } })),
  ]
}

// Per bucket, by the one reward definition (domain/loop/reaction).
function reactionsBy(rows: ReactedSend[], key: (row: ReactedSend) => string | null, weights: RewardWeights): Map<string | null, ReactionTotals> {
  return reactionTotalsByKey(rows.map((row) => ({ key: key(row), outreachLogId: row.outreachLogId, reaction: row.reaction })), weights)
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

// The evaluations screen counts sends old enough for every reply to have arrived.
const matured = (): SQL => lt(outreachLogs.sentAt, daysAgo(REPLY_ARRIVAL_DAYS))

type VariantTally = { variantId: string; total: number; rewardSum: number; responses: number } & Pick<ReactionTotals, 'positive' | 'interested'>

async function maturedVariantStats(db: Db, projectId: ProjectId, weights: RewardWeights): Promise<VariantTally[]> {
  const window = and(isNotNull(outreachLogs.variantId), matured())
  const [totals, reacted, replied] = await Promise.all([
    db.select({ variantId: outreachLogs.variantId, total: count() })
      .from(outreachLogs)
      .where(sentBy(projectId, window))
      .groupBy(outreachLogs.variantId)
      .orderBy(outreachLogs.variantId),
    reactedSends(db, projectId, window),
    // Distinct sends, so a thread of two replies stays one.
    db.select({ variantId: outreachLogs.variantId, responses: countDistinct(outreachLogs.id) })
      .from(outreachLogs)
      .innerJoin(responses, eq(responses.outreachLogId, outreachLogs.id))
      .where(and(sentBy(projectId, window), notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES])))
      .groupBy(outreachLogs.variantId),
  ])
  const reactions = reactionsBy(reacted, (r) => r.variantId, weights)
  const responsesBy = new Map(replied.map((r) => [r.variantId, r.responses]))
  return totals.flatMap(({ variantId, total }) => {
    if (variantId === null) return []
    const r = reactions.get(variantId)
    return [{ variantId, total, rewardSum: r?.rewardSum ?? 0, positive: r?.positive ?? 0, interested: r?.interested ?? 0, responses: responsesBy.get(variantId) ?? 0 }]
  })
}

// The variants as the rule sees them, for the lever-state view.
export async function getVariantEvidence(db: Db, projectId: ProjectId, config: LeverConfig, now: Date = new Date()): Promise<Map<string, Evidence>> {
  const sends = (await observeSends(db, projectId, await frameStart(db, projectId))).filter(recentEnough(config, now))
  return evidenceBy(sends, optionOf('variant'), now, config.reward)
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
  const mature = matured()
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
    maturedVariantStats(db, projectId, config.reward),
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

export type VariantEvidence = Evidence & {
  variantId: string
  addedOn: string
  label: string | null
  subjectPattern: string
  bodyApproach: string | null
  archived: OptionArchival | null
  // Trials since it last entered the active set: its grace, as the rule counts it.
  sinceEntry: number
}

// `fresh` = new after dedup. `registered` counts every prospect carrying the
// slug, hosted or brought in; `unqualified` = those failing the fit check or
// taken out by the person. Of the qualified: `sendable` on a channel the project
// has on, `channelsOff` only on one it has off (`channelsOffBy` per off channel;
// one prospect can count under several), `noContact` with none on file; the
// rest hold only a contact that cannot be used (refused, undeliverable, or on
// a platform no channel sends on).
export type StrategyDiscovery = {
  passes: number
  asked: number
  returned: number
  fresh: number
  registered: number
  unqualified: number
  sendable: number
  channelsOff: number
  channelsOffBy: Partial<Record<OutboundChannel, number>>
  noContact: number
}

export type StrategyEvidence = Evidence & {
  slug: string
  addedOn: string
  approach: string
  discovery: StrategyDiscovery
  archived: OptionArchival | null
}

export type EvidenceAxis = 'industry' | 'size' | 'country' | 'channel' | 'priority'
export type AxisBucket = Evidence & { value: string | null }

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
// fact once. The options are counted as the rule counts them.
export type ProposeEvidence = {
  frameStart: string | null
  sufficient: boolean
  kpi: Evidence
  variants: VariantEvidence[]
  strategies: StrategyEvidence[]
  axes: Record<EvidenceAxis, AxisBucket[]>
  repliedSends: RepliedSend[]
  inquiryOutcomes: Record<InquiryOutcome, number>
  channels: OutboundChannel[]
  discoveryCost: { usd: number; sendable: number }
}

const ARCHIVED_OPTIONS_SHOWN = 10
export const DISCOVERY_WINDOW_DAYS = 14
const REPLIED_SENDS_SHOWN = 30
const EVIDENCE_TEXT_CHARS = 1500
const SUFFICIENT_TRIALS = 30
const DISCOVERY_OPS = ['discover.search', 'discover.extract', 'enrich.judge', 'enrich.site', 'enrich.pages'] satisfies (GroundedTextOp | FollowUpJsonOp | PagesJsonOp)[]

export async function getProposeEvidence(db: Db, projectId: ProjectId, config: LeverConfig, now: Date = new Date()): Promise<ProposeEvidence> {
  const start = await frameStart(db, projectId)
  const inFrame = start === undefined ? undefined : gte(outreachLogs.sentAt, start)
  const countable = notInArray(responses.responseType, [...NON_COUNTABLE_RESPONSE_TYPES])
  const archivedInFrame = (column: typeof messageVariants.archivedAt | typeof discoveryStrategies.archivedAt) =>
    and(isNotNull(column), start === undefined ? undefined : gte(column, start))
  const variantCols = { id: messageVariants.variantId, label: messageVariants.label, subjectPattern: messageVariants.subjectPattern, bodyApproach: messageVariants.bodyApproach, createdAt: messageVariants.createdAt, archivedAt: messageVariants.archivedAt }
  const strategyCols = { id: discoveryStrategies.slug, approach: discoveryStrategies.approach, createdAt: discoveryStrategies.createdAt, archivedAt: discoveryStrategies.archivedAt }
  const { outboundChannels: channels } = await loadProjectOutboundAllowlist(db, projectId)
  const qualified = eq(projectProspects.qualified, true)
  const usable = usableOnExpr(channels)
  const offOnly = (on: readonly OutboundChannel[]) => sql`CASE WHEN ${qualified} AND NOT (${usable}) AND ${usableOnExpr(on)} THEN 1 END`
  const offChannels = OUTBOUND_CHANNELS.filter((c) => !channels.includes(c))

  const [
    sends, activeVariants, archivedVariants, activeStrategies, archivedStrategies,
    recent, inquiryRows, discoveryJobs, registeredRows, [discoveryCost],
  ] = await Promise.all([
    observeSends(db, projectId, start),
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
    // A job that failed left no result, so its passes are missing here.
    db.select({ result: jobs.result }).from(jobs)
      .where(and(eq(jobs.projectId, projectId), inArray(jobs.kind, ['daily_cycle', 'discover']), isNotNull(jobs.result), gte(jobs.createdAt, daysAgo(DISCOVERY_WINDOW_DAYS)))),
    db.select({
      strategy: prospects.discoveryStrategy,
      registered: count(),
      unqualified: count(sql`CASE WHEN NOT ${projectProspects.qualified} THEN 1 END`),
      sendable: count(sql`CASE WHEN ${qualified} AND ${usable} THEN 1 END`),
      channelsOff: count(offOnly(OUTBOUND_CHANNELS)),
      channelsOffBy: sql<Partial<Record<OutboundChannel, number>>>`jsonb_build_object(${sql.join(offChannels.map((c) => sql`${c}::text, COUNT(${offOnly([c])})`), sql`, `)})`,
      noContact: count(sql`CASE WHEN ${qualified} AND NOT ${projectTargetExpr} THEN 1 END`),
      foundSendable: count(sql`CASE WHEN ${prospects.origin} = 'found' AND ${qualified} AND ${usable} THEN 1 END`),
    })
      .from(projectProspects).innerJoin(prospects, eq(prospects.id, projectProspects.prospectId))
      .where(and(eq(projectProspects.projectId, projectId), isNotNull(prospects.discoveryStrategy), gte(projectProspects.createdAt, daysAgo(DISCOVERY_WINDOW_DAYS))))
      .groupBy(prospects.discoveryStrategy),
    db.select({ usd: sum(paidCalls.costUsd).mapWith(Number) }).from(paidCalls)
      .where(and(eq(paidCalls.projectId, projectId), inArray(paidCalls.op, DISCOVERY_OPS), gte(paidCalls.createdAt, daysAgo(DISCOVERY_WINDOW_DAYS)))),
  ])

  const recentIds = recent.map((r) => r.outreachLogId)
  const [replyRows, sessionRows, variantArchivals, strategyArchivals, variantEntries] = await Promise.all([
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
          reason: statedReason,
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
    lastArchivals(db, projectId, 'variant', archivedVariants.map((v) => v.id)),
    lastArchivals(db, projectId, 'strategy', archivedStrategies.map((st) => st.id)),
    optionEntries(db, projectId, 'variant'),
  ])

  const none = evidenceOf([], now, config.reward)
  const judged = sends.filter(recentEnough(config, now))
  const variantOf = optionEvidence(judged, 'variant', variantEntries, now, config.reward)
  const strategyOf = evidenceBy(judged, optionOf('strategy'), now, config.reward)
  const axisBuckets = (key: (send: SendObservation) => string | null): AxisBucket[] =>
    Array.from(evidenceBy(sends, key, now, config.reward), ([value, e]) => ({ value, ...e })).sort(
      (a, b) => b.sends - a.sends || (a.value ?? '').localeCompare(b.value ?? ''),
    )

  // An option archived by a Worker that predates the log has no row: the day is all that is known.
  const archival = (archivals: Map<string, OptionArchival>, id: string, at: Date | null): OptionArchival | null =>
    at === null ? null : archivals.get(id) ?? { day: dayOf(at), actor: null, reason: null }

  const registeredBy = new Map(registeredRows.map((r) => [r.strategy, r]))
  const noPasses = { passes: 0, asked: 0, returned: 0, fresh: 0 }
  const passesBy = new Map<string, typeof noPasses>()
  for (const { result } of discoveryJobs) {
    if (result === null || !('planCompliance' in result)) continue
    // A pass whose source was down upstream says nothing about the source.
    for (const pass of result.planCompliance.filter((p) => p.unavailable === 0)) {
      const held = passesBy.get(pass.slug) ?? noPasses
      passesBy.set(pass.slug, { passes: held.passes + 1, asked: held.asked + pass.asked, returned: held.returned + pass.returned, fresh: held.fresh + pass.fresh })
    }
  }

  const reactionsOf = new Map<number, Reaction[]>()
  const textsOf = new Map<number, string[]>()
  const sendOf = new Map<number, (typeof replyRows)[number]>()
  for (const row of replyRows) {
    sendOf.set(row.outreachLogId, row)
    reactionsOf.set(row.outreachLogId, [...(reactionsOf.get(row.outreachLogId) ?? []), { kind: 'reply', responseType: row.responseType, sentiment: row.sentiment, reason: primaryReasonOf(row.reason) }])
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

  const kpi = evidenceOf(sends, now, config.reward)
  const priorityBucket = (priority: number | null): string | null => (priority === null ? null : String(priority))
  return {
    frameStart: start === undefined ? null : dayOf(start),
    sufficient: kpi.trials >= SUFFICIENT_TRIALS,
    kpi,
    variants: [...activeVariants, ...archivedVariants].map((v) => ({
      variantId: v.id,
      addedOn: dayOf(v.createdAt),
      label: v.label,
      subjectPattern: v.subjectPattern,
      bodyApproach: v.bodyApproach,
      archived: archival(variantArchivals, v.id, v.archivedAt),
      ...(variantOf.all.get(v.id) ?? none),
      sinceEntry: variantOf.sinceEntry.get(v.id)?.trials ?? 0,
    })),
    strategies: [...activeStrategies, ...archivedStrategies].map((st) => ({
      slug: st.id,
      addedOn: dayOf(st.createdAt),
      approach: st.approach,
      discovery: {
        ...(passesBy.get(st.id) ?? noPasses),
        registered: registeredBy.get(st.id)?.registered ?? 0,
        unqualified: registeredBy.get(st.id)?.unqualified ?? 0,
        sendable: registeredBy.get(st.id)?.sendable ?? 0,
        channelsOff: registeredBy.get(st.id)?.channelsOff ?? 0,
        channelsOffBy: registeredBy.get(st.id)?.channelsOffBy ?? {},
        noContact: registeredBy.get(st.id)?.noContact ?? 0,
      },
      archived: archival(strategyArchivals, st.id, st.archivedAt),
      ...(strategyOf.get(st.id) ?? none),
    })),
    axes: {
      industry: axisBuckets((send) => coarseIndustry(send.industry)),
      size: axisBuckets((send) => send.employeeBand),
      country: axisBuckets((send) => send.country),
      channel: axisBuckets((send) => send.channel),
      priority: axisBuckets((send) => priorityBucket(send.priority)),
    },
    repliedSends,
    inquiryOutcomes,
    channels,
    discoveryCost: { usd: discoveryCost?.usd ?? 0, sendable: registeredRows.reduce((total, r) => total + r.foundSendable, 0) },
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

export type FramePeriod = {
  // null for the frame the project started with.
  start: { day: string; by: 'ace' | 'user'; reason: string | null } | null
  trials: number
  positive: number
}

// Every frame the project has run, oldest first, each counted on its own sends
// (until the next one started).
export async function frameHistory(db: Db, projectId: ProjectId, config: LeverConfig, now: Date = new Date()): Promise<FramePeriod[]> {
  const [starts, sends] = await Promise.all([frameStarts(db, projectId), observeSends(db, projectId, undefined)])
  return [null, ...starts].map((start, i) => {
    const next = starts[i]?.at
    const { trials, positive } = evidenceOf(
      sends.filter((send) => (start === null || send.sentAt >= start.at) && (next === undefined || send.sentAt < next)),
      now,
      config.reward,
    )
    return { start: start && { day: dayOf(start.at), by: start.actor, reason: start.reason }, trials, positive }
  })
}

export async function observeTick(db: Db, projectId: ProjectId, config: LeverConfig, now: Date = new Date()): Promise<TickEvidence> {
  const start = await frameStart(db, projectId)
  const [sends, activeIds, activeSlugs, lostIds, lostSlugs, variantEntries, strategyEntries, [state]] = await Promise.all([
    observeSends(db, projectId, start),
    loadActiveVariantIds(db, projectId),
    getActiveStrategySlugs(db, projectId),
    lostOptionIds(db, projectId, 'variant'),
    lostOptionIds(db, projectId, 'strategy'),
    optionEntries(db, projectId, 'variant'),
    optionEntries(db, projectId, 'strategy'),
    db.select({ variantFlatStreak: leverState.variantFlatStreak }).from(leverState).where(eq(leverState.projectId, projectId)),
  ])
  const judged = sends.filter(recentEnough(config, now))
  const variants = optionEvidence(judged, 'variant', variantEntries, now, config.reward)
  const strategies = optionEvidence(judged, 'strategy', strategyEntries, now, config.reward)
  return {
    variants: {
      active: activeIds.map((id) => {
        const e = variants.all.get(id)
        return { ...armOf(id, e), responses: e?.replied ?? 0, sinceEntry: variants.sinceEntry.get(id)?.trials ?? 0 }
      }),
      lost: lostIds.map((id) => armOf(id, variants.all.get(id))),
      flatStreak: state?.variantFlatStreak ?? 0,
    },
    strategies: {
      active: activeSlugs.map((slug) => ({ ...armOf(slug, strategies.all.get(slug)), sinceEntry: strategies.sinceEntry.get(slug)?.trials ?? 0 })),
      lost: lostSlugs.map((slug) => armOf(slug, strategies.all.get(slug))),
    },
    channel: channelStatsOf(sends, now, config.reward),
    targeting: targetingStatsOf(judged, now, config.reward),
    futility: futilityOf(sends, config, now),
    frame: evidenceOf(sends, now, config.reward),
  }
}
