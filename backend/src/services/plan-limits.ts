import { z } from 'zod'
import { eq, and, or, sql, gte, isNotNull } from 'drizzle-orm'
import {
  tenantPlans,
  outreachLogs,
  responses,
  sendingIdentities,
  prospects,
  inquirySessions,
  PRE_SEND_TTL_MINUTES,
} from '../db/schema'
import type { createDb } from '../db/connection'
import { ok, err, type ServiceError, type ServiceResult } from '../services/result'
import type { Edition } from '../domain/edition'
import { type SendingIdentityId, type TenantId } from '../domain/ids'
import { DEFAULT_WARMUP, mailboxDailyStatus } from '../domain/warmup'

// 'unlimited' is internal-only (no Stripe price), set manually in the DB for
// staff / complimentary accounts. The Stripe webhook must never overwrite it.
export type PlanTier = 'free' | 'starter' | 'pro' | 'scale' | 'unlimited'

export type OutreachWindowKind = 'daily' | 'lifetime' | 'monthly'

// Plans can apply zero or more caps simultaneously. null = cap doesn't apply.
// Free uses daily + lifetime (whichever runs out first blocks send); paid uses monthly.
export interface PlanLimits {
  maxProjects: number | null
  maxOutreachPerDay: number | null
  maxOutreachLifetime: number | null
  maxOutreachPerMonth: number | null
  maxProspects: number | null
  // Total identities (gmail + smtp); the connected Gmail occupies 1, so free (1)
  // cannot add an smtp identity.
  maxSendingIdentities: number | null
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:      { maxProjects: 1,    maxOutreachPerDay: 5,    maxOutreachLifetime: 50,   maxOutreachPerMonth: null,  maxProspects: 500,  maxSendingIdentities: 1 },
  starter:   { maxProjects: 1,    maxOutreachPerDay: null, maxOutreachLifetime: null, maxOutreachPerMonth: 1500,  maxProspects: null, maxSendingIdentities: 2 },
  pro:       { maxProjects: 5,    maxOutreachPerDay: null, maxOutreachLifetime: null, maxOutreachPerMonth: 10000, maxProspects: null, maxSendingIdentities: 5 },
  scale:     { maxProjects: null, maxOutreachPerDay: null, maxOutreachLifetime: null, maxOutreachPerMonth: null,  maxProspects: null, maxSendingIdentities: null },
  unlimited: { maxProjects: null, maxOutreachPerDay: null, maxOutreachLifetime: null, maxOutreachPerMonth: null,  maxProspects: null, maxSendingIdentities: null },
}

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan]
}

export function canRegisterSmtpIdentity(
  plan: PlanTier,
  currentIdentityCount: number,
): ServiceError | null {
  if (plan === 'free') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'Custom sending mailboxes require a paid plan',
      detail: 'Upgrade to Starter or higher to add an SMTP sending identity.',
    }
  }
  const cap = getPlanLimits(plan).maxSendingIdentities
  if (cap !== null && currentIdentityCount >= cap) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'Sending identity limit reached',
      detail: `Your ${plan} plan allows up to ${cap} sending ${cap === 1 ? 'identity' : 'identities'}. Remove one or upgrade to add more.`,
    }
  }
  return null
}

type Db = ReturnType<typeof createDb>

// Edition gate at this single chokepoint means every downstream cap check inherits the self-host override.
export async function getTenantPlan(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<{
  plan: PlanTier
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
}> {
  if (edition !== 'cloud') {
    return { plan: 'unlimited', currentPeriodStart: null, currentPeriodEnd: null }
  }

  const [row] = await db
    .select({
      plan: tenantPlans.plan,
      currentPeriodStart: tenantPlans.currentPeriodStart,
      currentPeriodEnd: tenantPlans.currentPeriodEnd,
    })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)

  if (!row) {
    return { plan: 'free', currentPeriodStart: null, currentPeriodEnd: null }
  }

  return {
    plan: row.plan,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
  }
}

export function startOfTodayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}

// Counts the tenant's distinct prospects, not project_prospect links:
// batchRegister allows `projectId.optional()` and writes only `prospects`
// when omitted, so a project_prospects-based count would let a tenant
// silently exceed the Free 500 cap by saving tenant-only prospects.
export async function countTenantProspects(db: Db, tenantId: TenantId): Promise<number> {
  const [result] = await db
    .select({ total: sql<number>`COUNT(*)::int` })
    .from(prospects)
    .where(eq(prospects.tenantId, tenantId))

  return result?.total ?? 0
}

export interface OutreachQuotaWindow {
  used: number
  limit: number
  remaining: number
}

export type OutreachQuota =
  | {
      plan: PlanTier
      kind: 'unlimited'
      used: number
    }
  | {
      plan: PlanTier
      kind: 'capped'
      used: number
      limit: number
      remaining: number
      bindingConstraint: OutreachWindowKind
      // Per-window breakdown so the frontend can show all applicable caps.
      daily?: OutreachQuotaWindow
      lifetime?: OutreachQuotaWindow
      monthly?: OutreachQuotaWindow
    }

// Tie-break: pick the most "terminal" (lifetime > monthly > daily) so the UX
// nudges toward the right action ("upgrade" beats "wait until tomorrow").
const TIE_BREAK_ORDER: Record<OutreachWindowKind, number> = {
  lifetime: 0,
  monthly: 1,
  daily: 2,
}

export function selectOutreachQuota(
  plan: PlanTier,
  windows: { kind: OutreachWindowKind; limit: number; used: number }[],
): OutreachQuota {
  if (windows.length === 0) return { plan, kind: 'unlimited', used: 0 }

  const candidates = windows.map((w) => ({
    kind: w.kind,
    window: { used: w.used, limit: w.limit, remaining: Math.max(0, w.limit - w.used) },
  }))
  candidates.sort((a, b) => {
    if (a.window.remaining !== b.window.remaining) return a.window.remaining - b.window.remaining
    return TIE_BREAK_ORDER[a.kind] - TIE_BREAK_ORDER[b.kind]
  })
  const binding = candidates[0]!

  const result: OutreachQuota = {
    plan,
    kind: 'capped',
    used: binding.window.used,
    limit: binding.window.limit,
    remaining: binding.window.remaining,
    bindingConstraint: binding.kind,
  }
  for (const c of candidates) {
    result[c.kind] = c.window
  }
  return result
}

export async function getRemainingOutreachQuota(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<OutreachQuota> {
  const tp = await getTenantPlan(db, tenantId, edition)
  return getRemainingOutreachQuotaForPlan(db, tenantId, tp)
}

// Variant for callers that already loaded the tenant plan (e.g. /me/plan).
export async function getRemainingOutreachQuotaForPlan(
  db: Db,
  tenantId: TenantId,
  tp: { plan: PlanTier; currentPeriodStart: Date | null },
): Promise<OutreachQuota> {
  const limits = getPlanLimits(tp.plan)

  const dailySince = limits.maxOutreachPerDay !== null ? startOfTodayUtc() : null
  const monthlySince = limits.maxOutreachPerMonth !== null && tp.currentPeriodStart
    ? tp.currentPeriodStart
    : null
  const includeLifetime = limits.maxOutreachLifetime !== null

  if (!dailySince && !monthlySince && !includeLifetime) {
    return { plan: tp.plan, kind: 'unlimited', used: 0 }
  }

  // Dates passed as ISO strings + ::timestamptz cast: postgres.js with
  // prepare:false (required for Supabase pooler) can't serialize Date instances
  // through raw sql`` interpolation — it expects string/Buffer/ArrayBuffer.
  const dailySinceIso = dailySince?.toISOString() ?? null
  const monthlySinceIso = monthlySince?.toISOString() ?? null
  const [row] = await db
    .select({
      dailyUsed: dailySinceIso
        ? sql<number>`COUNT(*) FILTER (WHERE ${outreachLogs.sentAt} >= ${dailySinceIso}::timestamptz)::int`
        : sql<number>`0::int`,
      monthlyUsed: monthlySinceIso
        ? sql<number>`COUNT(*) FILTER (WHERE ${outreachLogs.sentAt} >= ${monthlySinceIso}::timestamptz)::int`
        : sql<number>`0::int`,
      lifetimeUsed: includeLifetime
        ? sql<number>`COUNT(*)::int`
        : sql<number>`0::int`,
    })
    .from(outreachLogs)
    // 'pre_send' is an in-flight reservation: counted toward used so concurrent
    // allocations can't race past the cap; auto-refunded when
    // updateOutreachStatus flips to 'failed' (row stops matching). After
    // PRE_SEND_TTL_MINUTES, unresolved pre_send rows age out so a crashed
    // skill doesn't hold quota forever (row stays for audit).
    .where(and(
      eq(outreachLogs.tenantId, tenantId),
      or(
        eq(outreachLogs.status, 'sent'),
        and(
          eq(outreachLogs.status, 'pre_send'),
          sql`${outreachLogs.sentAt} > NOW() - (${PRE_SEND_TTL_MINUTES} * INTERVAL '1 minute')`,
        ),
      ),
    ))

  const windows: { kind: OutreachWindowKind; limit: number; used: number }[] = []
  if (limits.maxOutreachPerDay !== null) windows.push({ kind: 'daily', limit: limits.maxOutreachPerDay, used: row?.dailyUsed ?? 0 })
  if (includeLifetime) windows.push({ kind: 'lifetime', limit: limits.maxOutreachLifetime!, used: row?.lifetimeUsed ?? 0 })
  if (monthlySince) windows.push({ kind: 'monthly', limit: limits.maxOutreachPerMonth!, used: row?.monthlyUsed ?? 0 })

  return selectOutreachQuota(tp.plan, windows)
}

export function isOutreachQuotaExhausted(quota: OutreachQuota): boolean {
  return quota.kind === 'capped' && quota.remaining <= 0
}

export function outreachQuotaErrorIfExhausted(quota: OutreachQuota): ServiceError | null {
  if (quota.kind !== 'capped' || quota.remaining > 0) return null
  return {
    ok: false,
    code: 'FORBIDDEN',
    error: 'Outreach limit reached',
    detail: formatOutreachQuotaError(quota),
  }
}

export function formatOutreachQuotaError(quota: OutreachQuota): string {
  if (quota.kind === 'unlimited') return 'Outreach limit reached.'
  switch (quota.bindingConstraint) {
    case 'daily':
      return `Your ${quota.plan} plan allows ${quota.limit} outreach per day. Try again tomorrow or upgrade for higher limits.`
    case 'lifetime':
      return `Your ${quota.plan} plan lifetime limit (${quota.limit}) is reached. Upgrade to keep sending.`
    case 'monthly':
      return `Your ${quota.plan} plan allows ${quota.limit} outreach this month. Upgrade your plan to continue.`
  }
}

// Per-mailbox safe daily send cap. Orthogonal to the billing quota AND the
// edition gate (every plan and self-host is protected) because the failure mode
// is reputational, not commercial.
export type MailboxDailyQuota =
  | { kind: 'no_mailbox' }
  | {
      kind: 'capped'
      cap: number
      used: number
      remaining: number
      pausedUntil: Date | null
    }

export async function getMailboxDailyQuota(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId | null,
  now: Date = new Date(),
): Promise<MailboxDailyQuota> {
  if (!identityId) return { kind: 'no_mailbox' }
  const [mailbox] = await db
    .select({
      warmupStartedAt: sendingIdentities.warmupStartedAt,
      dailyCapOverride: sendingIdentities.dailyCapOverride,
      pausedUntil: sendingIdentities.pausedUntil,
    })
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
    .limit(1)

  if (!mailbox) return { kind: 'no_mailbox' }

  const used = await countMailboxEmailSendsToday(db, tenantId, identityId, now)
  const status = mailboxDailyStatus(mailbox, used, DEFAULT_WARMUP, now)
  return {
    kind: 'capped',
    cap: status.cap,
    used: status.used,
    remaining: status.remaining,
    pausedUntil: status.pausedUntil,
  }
}

// Counted by sending_identity_id, not from_email: a Send-As alias drifts
// from_email while the mailbox/reputation stays the same identity.
async function countMailboxEmailSendsToday(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId,
  now: Date,
): Promise<number> {
  const sinceIso = startOfTodayUtc(now).toISOString()
  const [row] = await db
    .select({ used: sql<number>`COUNT(*)::int` })
    .from(outreachLogs)
    .where(and(
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.sendingIdentityId, identityId),
      eq(outreachLogs.channel, 'email'),
      sql`${outreachLogs.sentAt} >= ${sinceIso}::timestamptz`,
      or(
        eq(outreachLogs.status, 'sent'),
        and(
          eq(outreachLogs.status, 'pre_send'),
          sql`${outreachLogs.sentAt} > NOW() - (${PRE_SEND_TTL_MINUTES} * INTERVAL '1 minute')`,
        ),
      ),
    ))
  return row?.used ?? 0
}

// Same predicate as countMailboxEmailSendsToday, grouped for the per-identity
// health list (avoids one count query per identity). A NULL sending_identity_id
// (legacy rows) is dropped since it maps to no identity.
export async function countMailboxEmailSendsTodayByIdentity(
  db: Db,
  tenantId: TenantId,
  now: Date = new Date(),
): Promise<Map<string, number>> {
  const sinceIso = startOfTodayUtc(now).toISOString()
  const rows = await db
    .select({
      identityId: outreachLogs.sendingIdentityId,
      used: sql<number>`COUNT(*)::int`,
    })
    .from(outreachLogs)
    .where(and(
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.channel, 'email'),
      sql`${outreachLogs.sentAt} >= ${sinceIso}::timestamptz`,
      or(
        eq(outreachLogs.status, 'sent'),
        and(
          eq(outreachLogs.status, 'pre_send'),
          sql`${outreachLogs.sentAt} > NOW() - (${PRE_SEND_TTL_MINUTES} * INTERVAL '1 minute')`,
        ),
      ),
    ))
    .groupBy(outreachLogs.sendingIdentityId)
  const byIdentity = new Map<string, number>()
  for (const r of rows) {
    if (r.identityId) byIdentity.set(r.identityId, r.used)
  }
  return byIdentity
}

export function isMailboxQuotaExhausted(quota: MailboxDailyQuota): boolean {
  return quota.kind === 'capped' && quota.remaining <= 0
}

export function mailboxQuotaErrorIfExhausted(quota: MailboxDailyQuota): ServiceError | null {
  if (!isMailboxQuotaExhausted(quota)) return null
  return {
    ok: false,
    code: 'FORBIDDEN',
    error: 'Mailbox daily send cap reached',
    detail: formatMailboxQuotaError(quota),
  }
}

export function formatMailboxQuotaError(quota: MailboxDailyQuota): string {
  if (quota.kind !== 'capped') return 'Mailbox daily send cap reached.'
  if (quota.pausedUntil) {
    return `Sending from this mailbox is paused until ${quota.pausedUntil.toISOString()}.`
  }
  return `This mailbox's safe daily send limit (${quota.cap}/day) is reached. This protects your sending domain's reputation; it resets at UTC midnight. Reach remaining prospects by form/SNS, or continue tomorrow.`
}

// Exposes the warmup state behind the per-mailbox daily cap —
// getMailboxDailyQuota only returns the resulting cap/used/remaining, so
// operators can't see ramp progress from it.
export type MailboxHealth =
  | { kind: 'no_mailbox' }
  | {
      kind: 'active'
      email: string
      warmupStartedAt: Date | null
      dailyCapOverride: number | null
      pausedUntil: Date | null
      rampWeek: number
      rampWeeks: number
      steadyStatePerDay: number
      cap: number
      used: number
      remaining: number
      bounceWindowDays: number
      sentInWindow: number
      bounced: number
      bounceRate: number
    }

// Matches the reply-ingest attribution window: a bounce is only attributed within 30d.
const BOUNCE_RATE_WINDOW_DAYS = 30

async function countMailboxBounceWindow(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId,
  now: Date,
): Promise<{ sentInWindow: number; bounced: number }> {
  const sinceIso = new Date(now.getTime() - BOUNCE_RATE_WINDOW_DAYS * 86_400_000).toISOString()
  const [row] = await db
    .select({
      sentInWindow: sql<number>`COUNT(DISTINCT ${outreachLogs.id})::int`,
      bounced: sql<number>`COUNT(DISTINCT ${outreachLogs.id}) FILTER (WHERE ${responses.responseType} = 'bounce')::int`,
    })
    .from(outreachLogs)
    .leftJoin(
      responses,
      and(eq(responses.outreachLogId, outreachLogs.id), eq(responses.tenantId, outreachLogs.tenantId)),
    )
    .where(and(
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.sendingIdentityId, identityId),
      eq(outreachLogs.channel, 'email'),
      eq(outreachLogs.status, 'sent'),
      isNotNull(outreachLogs.messageId),
      sql`${outreachLogs.sentAt} >= ${sinceIso}::timestamptz`,
    ))
  return { sentInWindow: row?.sentInWindow ?? 0, bounced: row?.bounced ?? 0 }
}

export async function getMailboxHealth(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId | null,
  now: Date = new Date(),
): Promise<MailboxHealth> {
  if (!identityId) return { kind: 'no_mailbox' }
  const [mailbox] = await db
    .select({
      email: sendingIdentities.fromEmail,
      warmupStartedAt: sendingIdentities.warmupStartedAt,
      dailyCapOverride: sendingIdentities.dailyCapOverride,
      pausedUntil: sendingIdentities.pausedUntil,
    })
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
    .limit(1)

  if (!mailbox) return { kind: 'no_mailbox' }

  const [used, bounceWindow] = await Promise.all([
    countMailboxEmailSendsToday(db, tenantId, identityId, now),
    countMailboxBounceWindow(db, tenantId, identityId, now),
  ])
  const status = mailboxDailyStatus(mailbox, used, DEFAULT_WARMUP, now)
  return {
    kind: 'active',
    email: mailbox.email,
    warmupStartedAt: mailbox.warmupStartedAt,
    dailyCapOverride: mailbox.dailyCapOverride,
    ...status,
    bounceWindowDays: BOUNCE_RATE_WINDOW_DAYS,
    sentInWindow: bounceWindow.sentInWindow,
    bounced: bounceWindow.bounced,
    bounceRate:
      bounceWindow.sentInWindow === 0
        ? 0
        : Math.round((bounceWindow.bounced / bounceWindow.sentInWindow) * 1000) / 10,
  }
}

const MAX_DAILY_CAP_OVERRIDE = 100_000

export const updateMailboxWarmupSchema = z
  .object({
    dailyCapOverride: z.number().int().min(0).max(MAX_DAILY_CAP_OVERRIDE).nullable().optional(),
    pausedUntil: z.iso.datetime().nullable().optional(),
  })
  .strict()
  .refine(
    (p) => p.dailyCapOverride !== undefined || p.pausedUntil !== undefined,
    { message: 'Provide dailyCapOverride or pausedUntil to update.' },
  )

export type UpdateMailboxWarmupPatch = z.infer<typeof updateMailboxWarmupSchema>

export async function updateMailboxWarmup(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId,
  patch: UpdateMailboxWarmupPatch,
  now: Date = new Date(),
): Promise<ServiceResult<MailboxHealth>> {
  const updateSet = {
    ...(patch.dailyCapOverride !== undefined ? { dailyCapOverride: patch.dailyCapOverride } : {}),
    ...(patch.pausedUntil !== undefined
      ? { pausedUntil: patch.pausedUntil === null ? null : new Date(patch.pausedUntil) }
      : {}),
    updatedAt: now,
  }

  const updated = await db
    .update(sendingIdentities)
    .set(updateSet)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
    .returning({ identityId: sendingIdentities.identityId })

  if (updated.length === 0) {
    return err(
      'NOT_FOUND',
      'Sending identity not found',
      'No sending identity with that id for this account.',
    )
  }

  return ok(await getMailboxHealth(db, tenantId, identityId, now))
}

// 1 turn = 1 user message + 1 AI reply (counted on the AI reply via
// inquiry_sessions.chat_turns_used).
export type InquiryChatWindowKind = 'lifetime' | 'monthly'

export type InquiryChatLimits = {
  maxChatTurnsLifetime: number | null
  maxChatTurnsPerMonth: number | null
}

const INQUIRY_CHAT_LIMITS: Record<PlanTier, InquiryChatLimits> = {
  free:      { maxChatTurnsLifetime: 25,   maxChatTurnsPerMonth: null },
  starter:   { maxChatTurnsLifetime: null, maxChatTurnsPerMonth: 500 },
  pro:       { maxChatTurnsLifetime: null, maxChatTurnsPerMonth: 5000 },
  scale:     { maxChatTurnsLifetime: null, maxChatTurnsPerMonth: null },
  unlimited: { maxChatTurnsLifetime: null, maxChatTurnsPerMonth: null },
}

export type InquiryChatQuota =
  | {
      plan: PlanTier
      kind: 'unlimited'
      used: number
    }
  | {
      plan: PlanTier
      kind: 'capped'
      used: number
      limit: number
      remaining: number
      bindingConstraint: InquiryChatWindowKind
    }

export async function getRemainingChatQuota(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<InquiryChatQuota> {
  const tp = await getTenantPlan(db, tenantId, edition)
  const limits = INQUIRY_CHAT_LIMITS[tp.plan]

  const lifetimeLimit = limits.maxChatTurnsLifetime
  const monthlyLimit = limits.maxChatTurnsPerMonth
  const monthlySince = monthlyLimit !== null && tp.currentPeriodStart ? tp.currentPeriodStart : null

  if (lifetimeLimit === null && monthlySince === null) {
    return { plan: tp.plan, kind: 'unlimited', used: 0 }
  }

  // Either lifetime (free) or monthly (paid) — never both.
  const windowKind: InquiryChatWindowKind = lifetimeLimit !== null ? 'lifetime' : 'monthly'
  const limit = (lifetimeLimit ?? monthlyLimit) as number
  const where =
    windowKind === 'lifetime'
      ? eq(inquirySessions.tenantId, tenantId)
      : and(
          eq(inquirySessions.tenantId, tenantId),
          gte(inquirySessions.openedAt, monthlySince as Date),
        )
  const [row] = await db
    .select({ used: sql<number>`COALESCE(SUM(${inquirySessions.chatTurnsUsed}), 0)::int` })
    .from(inquirySessions)
    .where(where)

  const used = row?.used ?? 0

  return {
    plan: tp.plan,
    kind: 'capped',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    bindingConstraint: windowKind,
  }
}

export function isChatQuotaExhausted(quota: InquiryChatQuota): boolean {
  return quota.kind === 'capped' && quota.remaining <= 0
}

export function formatChatQuotaError(quota: InquiryChatQuota): string {
  if (quota.kind === 'unlimited') return 'Chat limit reached.'
  switch (quota.bindingConstraint) {
    case 'lifetime':
      return `Your ${quota.plan} plan inquiry-chat lifetime limit (${quota.limit} turns) is reached. Upgrade to enable more chat conversations.`
    case 'monthly':
      return `Your ${quota.plan} plan allows ${quota.limit} inquiry-chat turns per month. Upgrade your plan to continue.`
  }
}
