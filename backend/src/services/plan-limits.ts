import { z } from 'zod'
import { eq, and, or, sql, gte, isNotNull } from 'drizzle-orm'
import {
  tenantPlans,
  outreachLogs,
  responses,
  sendingIdentities,
  prospects,
  discoveryCharges,
  creditLedger,
  inquirySessions,
  PRE_SEND_TTL_MINUTES,
} from '../db/schema'
import type { createDb } from '../db/connection'
import { ok, err, type ServiceError, type ServiceResult } from '../services/result'
import type { Edition } from '../domain/edition'
import { creditsCoverOverage, USAGE_PRICE_CENTS, type AutoTopUp, type CreditState } from '../domain/credits'
import { type SendingIdentityId, type TenantId } from '../domain/ids'
import {
  BOUNCE_RATE_WINDOW_DAYS,
  DEFAULT_WARMUP,
  mailboxBounceWindow,
  mailboxDailyStatus,
  type MailboxBounceCounts,
  type MailboxBounceWindow,
  type MailboxDailyStatus,
  type MailboxPoolPick,
  type MailboxSendRefusal,
} from '../domain/warmup'

// 'unlimited' is internal-only (no Stripe price), set manually in the DB for
// staff / complimentary accounts. The Stripe webhook must never overwrite it.
export type PlanTier = 'free' | 'starter' | 'pro' | 'scale' | 'unlimited'

export type QuotaWindowKind = 'lifetime' | 'monthly'

// Plans meter prospects, not sends: a prospect counts once, when its first
// outbound goes out; follow-ups and re-approaches are free. Discovery is
// metered separately at registration because that is where its cost lands.
export interface ProspectCaps {
  window: QuotaWindowKind
  // Distinct prospects first contacted within the window.
  contacted: number
  // Prospects the hosted discovery may register within the window.
  found: number
}

export interface PlanLimits {
  maxProjects: number | null
  // null = no prospect metering (the internal unlimited tier).
  prospectCaps: ProspectCaps | null
  // Prospects stored, any origin: a storage guard, not what the plan sells.
  maxProspects: number | null
  // Total identities (gmail + smtp); the connected Gmail occupies 1, so a
  // cap of 1 cannot add another mailbox.
  maxSendingIdentities: number | null
}

const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free:      { maxProjects: 1,    prospectCaps: { window: 'lifetime', contacted: 30,  found: 30 },  maxProspects: 500,  maxSendingIdentities: 1 },
  starter:   { maxProjects: 1,    prospectCaps: { window: 'monthly',  contacted: 100, found: 100 }, maxProspects: null, maxSendingIdentities: 1 },
  pro:       { maxProjects: 5,    prospectCaps: { window: 'monthly',  contacted: 300, found: 300 }, maxProspects: null, maxSendingIdentities: 3 },
  scale:     { maxProjects: null, prospectCaps: { window: 'monthly',  contacted: 800, found: 800 }, maxProspects: null, maxSendingIdentities: 10 },
  unlimited: { maxProjects: null, prospectCaps: null,                                                maxProspects: null, maxSendingIdentities: null },
}

export function getPlanLimits(plan: PlanTier): PlanLimits {
  return PLAN_LIMITS[plan]
}

// The sign-in Gmail counts toward the total; another Google account, an SMTP
// mailbox and a Gmail Send-As alias are each one more.
export function canRegisterMailbox(
  plan: PlanTier,
  currentIdentityCount: number,
): ServiceError | null {
  if (plan === 'free') {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'Additional sending mailboxes require a paid plan',
      detail: 'Upgrade to Starter or higher to add another Google account, an SMTP mailbox or a Gmail Send-As alias.',
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

export interface TenantPlan {
  plan: PlanTier
  currentPeriodStart: Date | null
  currentPeriodEnd: Date | null
  // null = the plan cannot hold prepaid credits (free, unlimited, self-host).
  autoTopUp: AutoTopUp | null
}

const NO_SUBSCRIPTION = { currentPeriodStart: null, currentPeriodEnd: null, autoTopUp: null } as const

// Edition gate at this single chokepoint means every downstream cap check inherits the self-host override.
export async function getTenantPlan(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<TenantPlan> {
  if (edition !== 'cloud') return { plan: 'unlimited', ...NO_SUBSCRIPTION }

  const [row] = await db
    .select({
      plan: tenantPlans.plan,
      currentPeriodStart: tenantPlans.currentPeriodStart,
      currentPeriodEnd: tenantPlans.currentPeriodEnd,
      autoTopUpEnabled: tenantPlans.autoTopUpEnabled,
      autoTopUpAmountCents: tenantPlans.autoTopUpAmountCents,
      autoTopUpThresholdCents: tenantPlans.autoTopUpThresholdCents,
      autoTopUpFailedAt: tenantPlans.autoTopUpFailedAt,
    })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)

  if (!row) return { plan: 'free', ...NO_SUBSCRIPTION }

  return {
    plan: row.plan,
    currentPeriodStart: row.currentPeriodStart,
    currentPeriodEnd: row.currentPeriodEnd,
    autoTopUp: holdsCredits(row.plan)
      ? {
          enabled: row.autoTopUpEnabled,
          amountCents: row.autoTopUpAmountCents,
          thresholdCents: row.autoTopUpThresholdCents,
          failedAt: row.autoTopUpFailedAt,
        }
      : null,
  }
}

export const PAID_PLAN_TIERS = ['starter', 'pro', 'scale'] as const
export type PaidPlanTier = (typeof PAID_PLAN_TIERS)[number]

// Credits are bought against the subscription's Stripe customer, so only a
// paid tier holds them; free has nothing to charge and unlimited nothing to
// cover.
export function holdsCredits(plan: PlanTier): plan is PaidPlanTier {
  return PAID_PLAN_TIERS.some((tier) => tier === plan)
}

export async function sumCreditBalance(db: Db, tenantId: TenantId): Promise<number> {
  const [row] = await db
    .select({ balance: sql<number>`COALESCE(SUM(${creditLedger.amountCents}), 0)::int` })
    .from(creditLedger)
    .where(eq(creditLedger.tenantId, tenantId))
  return row?.balance ?? 0
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

export interface QuotaUsage {
  used: number
  limit: number
  remaining: number
}

export type ProspectQuota =
  | {
      plan: PlanTier
      kind: 'unlimited'
    }
  | {
      plan: PlanTier
      kind: 'capped'
      window: QuotaWindowKind
      // Past an allowance the excess is debited from prepaid credits instead
      // of refused, while creditsCoverOverage holds.
      credits: CreditState
      contacted: QuotaUsage
      found: QuotaUsage
    }

export function buildProspectQuota(
  plan: PlanTier,
  caps: ProspectCaps,
  credits: CreditState,
  used: { contacted: number; found: number },
): ProspectQuota {
  const usage = (limit: number, n: number): QuotaUsage => ({ used: n, limit, remaining: Math.max(0, limit - n) })
  return {
    plan,
    kind: 'capped',
    window: caps.window,
    credits,
    contacted: usage(caps.contacted, used.contacted),
    found: usage(caps.found, used.found),
  }
}

export async function getRemainingProspectQuota(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<ProspectQuota> {
  const tp = await getTenantPlan(db, tenantId, edition)
  return getRemainingProspectQuotaForPlan(db, tenantId, tp)
}

// 'pre_send' is an in-flight reservation: counted so concurrent allocations
// can't race past the cap; auto-refunded when updateOutreachStatus flips to
// 'failed' (row stops matching). After PRE_SEND_TTL_MINUTES, unresolved
// pre_send rows age out so a crashed skill doesn't hold quota forever (row
// stays for audit).
function spendsQuota(tenantId: TenantId) {
  return and(
    eq(outreachLogs.tenantId, tenantId),
    or(
      eq(outreachLogs.status, 'sent'),
      and(
        eq(outreachLogs.status, 'pre_send'),
        sql`${outreachLogs.sentAt} > NOW() - (${PRE_SEND_TTL_MINUTES} * INTERVAL '1 minute')`,
      ),
    ),
  )
}

// Variant for callers that already loaded the tenant plan (e.g. /me/plan).
export async function getRemainingProspectQuotaForPlan(
  db: Db,
  tenantId: TenantId,
  tp: TenantPlan,
): Promise<ProspectQuota> {
  const caps = getPlanLimits(tp.plan).prospectCaps
  if (!caps) return { plan: tp.plan, kind: 'unlimited' }
  // Dates passed as ISO strings + ::timestamptz cast: postgres.js with
  // prepare:false (required for Supabase pooler) can't serialize Date instances
  // through raw sql`` interpolation — it expects string/Buffer/ArrayBuffer.
  const sinceIso = caps.window === 'monthly' ? tp.currentPeriodStart?.toISOString() ?? null : null
  // A paid row without a period (manual setup) has no window to count in.
  if (caps.window === 'monthly' && sinceIso === null) return { plan: tp.plan, kind: 'unlimited' }

  const firstTouches = db
    .select({
      prospectId: outreachLogs.prospectId,
      firstAt: sql<Date>`MIN(${outreachLogs.sentAt})`.as('first_at'),
    })
    .from(outreachLogs)
    .where(spendsQuota(tenantId))
    .groupBy(outreachLogs.prospectId)
    .as('first_touches')

  const [[contacted], [found], balanceCents] = await Promise.all([
    db
      .select({ used: sql<number>`COUNT(*)::int` })
      .from(firstTouches)
      .where(sinceIso ? sql`${firstTouches.firstAt} >= ${sinceIso}::timestamptz` : undefined),
    db
      .select({ used: sql<number>`COUNT(*)::int` })
      .from(discoveryCharges)
      .where(and(
        eq(discoveryCharges.tenantId, tenantId),
        sinceIso ? sql`${discoveryCharges.createdAt} >= ${sinceIso}::timestamptz` : undefined,
      )),
    tp.autoTopUp ? sumCreditBalance(db, tenantId) : Promise.resolve(0),
  ])

  const credits: CreditState = tp.autoTopUp ? { balanceCents, autoTopUp: tp.autoTopUp } : null
  return buildProspectQuota(tp.plan, caps, credits, {
    contacted: contacted?.used ?? 0,
    found: found?.used ?? 0,
  })
}

// Exhausted = nothing new may go out; credits that cover the excess never exhaust.
export function isContactQuotaExhausted(quota: ProspectQuota): boolean {
  return quota.kind === 'capped' && quota.contacted.remaining <= 0 && !creditsCoverOverage(quota.credits, USAGE_PRICE_CENTS.contacted)
}

export function isFoundQuotaExhausted(quota: ProspectQuota): boolean {
  return quota.kind === 'capped' && quota.found.remaining <= 0 && !creditsCoverOverage(quota.credits, USAGE_PRICE_CENTS.found)
}

const WINDOW_PHRASE: Record<QuotaWindowKind, string> = {
  lifetime: 'in total',
  monthly: 'per billing period',
}

export function formatContactQuotaError(quota: ProspectQuota): string {
  if (quota.kind === 'unlimited') return 'Prospect limit reached.'
  const { limit } = quota.contacted
  const resume = quota.window === 'lifetime'
    ? 'Upgrade to reach new prospects.'
    : 'New prospects resume next period; buy credits or upgrade on the plans page to continue now.'
  return `Your ${quota.plan} plan includes ${limit} prospects ${WINDOW_PHRASE[quota.window]} and all ${limit} have been contacted. Follow-ups still go out. ${resume}`
}

export function formatFoundQuotaError(quota: ProspectQuota): string {
  if (quota.kind === 'unlimited') return 'Prospect discovery limit reached.'
  const { limit } = quota.found
  const resume = quota.window === 'lifetime'
    ? 'Bring your own list, or upgrade.'
    : 'Bring your own list, or buy credits or upgrade on the plans page.'
  return `Your ${quota.plan} plan lets LeadAce find ${limit} prospects ${WINDOW_PHRASE[quota.window]}, and that allowance is used. ${resume}`
}

// Discovery spends our money on prospects the plan could not register or
// contact; either spent allowance pauses it.
export function discoveryPausedReason(quota: ProspectQuota): string | null {
  if (isFoundQuotaExhausted(quota)) return formatFoundQuotaError(quota)
  if (isContactQuotaExhausted(quota)) return `Discovery is paused: ${formatContactQuotaError(quota)}`
  return null
}

async function hasPriorSend(db: Db, tenantId: TenantId, prospectId: number): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(outreachLogs)
    .where(and(
      eq(outreachLogs.tenantId, tenantId),
      eq(outreachLogs.prospectId, prospectId),
      eq(outreachLogs.status, 'sent'),
    ))
    .limit(1)
  return row !== undefined
}

// The send-path guard, run before the outbound row is written: a first touch
// past the allowance is refused unless credits cover it — then the send
// debits them once it is 'sent' (markProspectContacted). A follow-up to a
// prospect already contacted is never refused and never debited.
//
// A send on credits holds the tenant lock from here to commit (the same lock
// discovery takes for a found batch), so two debits cannot both read a
// balance that covers only one of them: the balance never goes negative.
export type ContactQuotaDecision = { chargeCredits: boolean }

export async function assertProspectContactQuota(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  prospectId: number,
): Promise<ServiceResult<ContactQuotaDecision>> {
  const quota = await getRemainingProspectQuota(db, tenantId, edition)
  if (quota.kind !== 'capped' || quota.contacted.remaining > 0) return ok({ chargeCredits: false })
  if (await hasPriorSend(db, tenantId, prospectId)) return ok({ chargeCredits: false })
  if (quota.credits === null) return err('FORBIDDEN', 'Prospect limit reached', formatContactQuotaError(quota))
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`)
  const balanceCents = await sumCreditBalance(db, tenantId)
  if (creditsCoverOverage({ ...quota.credits, balanceCents }, USAGE_PRICE_CENTS.contacted)) return ok({ chargeCredits: true })
  return err('FORBIDDEN', 'Prospect limit reached', formatContactQuotaError(quota))
}

// Per-mailbox safe daily send cap, summed over the project's mailbox pool
// (services/mailbox.ts picks the mailbox). Orthogonal to the billing quota AND
// the edition gate (every plan and self-host is protected) because the failure
// mode is reputational, not commercial.
export type MailboxDailyQuota = { kind: 'no_mailbox' } | MailboxPoolPick<SendingIdentityId>

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
  return quota.kind === 'exhausted'
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
  if (quota.kind !== 'exhausted') return 'Mailbox daily send cap reached.'
  if (quota.resumesAt) {
    return `Every mailbox this project sends from is paused or held after a provider refusal; the earliest lifts at ${quota.resumesAt.toISOString()} (a mailbox at its cap then still waits for UTC midnight). Check each mailbox in Account settings.`
  }
  return `Every mailbox this project sends from is at its safe daily send limit (${quota.cap}/day in total). This protects your sending domains' reputation; it resets at UTC midnight. Reach remaining prospects by form/SNS, or continue tomorrow.`
}

export async function recordMailboxRefusal(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId | null,
  detail: string,
  now: Date = new Date(),
): Promise<void> {
  if (!identityId) return
  const at = now.toISOString()
  const first: MailboxSendRefusal = {
    since: at,
    lastAt: at,
    detail,
    sentThatDay: await countMailboxEmailSendsToday(db, tenantId, identityId, now),
  }
  await db
    .update(sendingIdentities)
    .set({
      sendRefusal: sql`COALESCE(${sendingIdentities.sendRefusal}, ${JSON.stringify(first)}::jsonb) || ${JSON.stringify({ lastAt: at, detail })}::jsonb`,
      updatedAt: now,
    })
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
}

// Only a send that started after the latest refusal shows it lifted; an earlier
// attempt finishing late must not clear it.
export async function clearMailboxSendRefusal(
  db: Db,
  tenantId: TenantId,
  identityId: SendingIdentityId | null,
  attemptStartedAt: Date,
): Promise<void> {
  if (!identityId) return
  await db
    .update(sendingIdentities)
    .set({ sendRefusal: null })
    .where(and(
      eq(sendingIdentities.tenantId, tenantId),
      eq(sendingIdentities.identityId, identityId),
      sql`(${sendingIdentities.sendRefusal} ->> 'lastAt')::timestamptz < ${attemptStartedAt.toISOString()}::timestamptz`,
    ))
}

// Exposes the warmup state behind the per-mailbox daily cap — the send guard
// (pickProjectMailbox) only returns the resulting cap/used/remaining, so
// operators can't see ramp progress from it.
export type MailboxHealth =
  | { kind: 'no_mailbox' }
  | ({
      kind: 'active'
      email: string
      warmupStartedAt: Date | null
      dailyCapOverride: number | null
      sendRefusal: MailboxSendRefusal | null
    } & MailboxDailyStatus &
      MailboxBounceWindow)

// Grouped like countMailboxEmailSendsTodayByIdentity: one query serves both the
// single-mailbox health read and the per-identity list.
export async function countMailboxBounceWindowByIdentity(
  db: Db,
  tenantId: TenantId,
  now: Date = new Date(),
): Promise<Map<string, MailboxBounceCounts>> {
  const sinceIso = new Date(now.getTime() - BOUNCE_RATE_WINDOW_DAYS * 86_400_000).toISOString()
  const rows = await db
    .select({
      identityId: outreachLogs.sendingIdentityId,
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
      eq(outreachLogs.channel, 'email'),
      eq(outreachLogs.status, 'sent'),
      isNotNull(outreachLogs.messageId),
      sql`${outreachLogs.sentAt} >= ${sinceIso}::timestamptz`,
    ))
    .groupBy(outreachLogs.sendingIdentityId)
  const byIdentity = new Map<string, MailboxBounceCounts>()
  for (const r of rows) {
    if (r.identityId) byIdentity.set(r.identityId, { sentInWindow: r.sentInWindow, bounced: r.bounced })
  }
  return byIdentity
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
      sendRefusal: sendingIdentities.sendRefusal,
    })
    .from(sendingIdentities)
    .where(and(eq(sendingIdentities.tenantId, tenantId), eq(sendingIdentities.identityId, identityId)))
    .limit(1)

  if (!mailbox) return { kind: 'no_mailbox' }

  const [used, bounceByIdentity] = await Promise.all([
    countMailboxEmailSendsToday(db, tenantId, identityId, now),
    countMailboxBounceWindowByIdentity(db, tenantId, now),
  ])
  return {
    kind: 'active',
    email: mailbox.email,
    warmupStartedAt: mailbox.warmupStartedAt,
    dailyCapOverride: mailbox.dailyCapOverride,
    sendRefusal: mailbox.sendRefusal,
    ...mailboxDailyStatus(mailbox, used, DEFAULT_WARMUP, now),
    ...mailboxBounceWindow(bounceByIdentity.get(identityId)),
  }
}

const MAX_DAILY_CAP_OVERRIDE = 100_000

export const updateMailboxWarmupSchema = z
  .object({
    dailyCapOverride: z.number().int().min(0).max(MAX_DAILY_CAP_OVERRIDE).nullable().optional(),
    pausedUntil: z.iso.datetime().nullable().optional(),
    resolveRefusal: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (p) => p.dailyCapOverride !== undefined || p.pausedUntil !== undefined || p.resolveRefusal !== undefined,
    { message: 'Provide dailyCapOverride, pausedUntil or resolveRefusal to update.' },
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
    ...(patch.resolveRefusal ? { sendRefusal: null } : {}),
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
