import { z } from 'zod'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import type { CloudEdition } from '../domain/edition'
import { ok, err, type ServiceError, type ServiceResult } from './result'
import { stripeApiRequest } from './stripe-api'
import { isCardDecline } from '../domain/credits'
import { planOfPrice, requireStripeSubscription } from './billing'
import { PAID_PLAN_TIERS, planFromMetadata, type PaidPlanTier } from './plan-limits'
import { periodFromSubscription } from './stripe-webhook'

// `fromPlan` and `periodEnd` are what the user confirmed against; a change is
// refused when the subscription has moved on since, so a confirmed period-end
// switch never turns into an immediate charge or lands a period later.
export const planChangeBodySchema = z.object({
  priceId: z.string().min(1),
  fromPlan: z.enum(PAID_PLAN_TIERS),
  periodEnd: z.iso.datetime(),
})
export type PlanChangeBody = z.infer<typeof planChangeBodySchema>

export type SubscriptionInfo = {
  periodEnd: string
  // When Stripe ends the subscription; null = it renews.
  endsAt: string | null
  // The plan a schedule switches to at the period end; null = none pending.
  scheduledPlan: PaidPlanTier | null
}

// An upgrade the person's bank wants to authenticate waits, applied by Stripe
// only once its invoice is paid; the page completes it with the secret.
export type PlanChangeResult =
  | { status: 'done'; subscription: SubscriptionInfo }
  | { status: 'requires_action'; clientSecret: string }

type StripePrice = { id: string; metadata: Record<string, string> }

// A phase item carries the price id, or the price object once expanded.
type StripeSchedulePhase<Price> = {
  start_date: number
  end_date: number
  items: Array<{ price: Price; quantity: number }>
  automatic_tax?: { enabled: boolean }
}

export type StripeSchedule = {
  id: string
  current_phase: { start_date: number } | null
  phases: StripeSchedulePhase<StripePrice>[]
}
type CreatedStripeSchedule = { id: string; phases: StripeSchedulePhase<string>[] }

type StripeSubscription = {
  id: string
  status: string
  // Set by every scheduled cancellation. A flexible-billing subscription
  // cancelled in the Customer Portal leaves cancel_at_period_end false.
  cancel_at: number | null
  // An upgrade waiting on its payment (payment_behavior=pending_if_incomplete);
  // latest_invoice is that payment's invoice while it is set.
  pending_update: unknown
  latest_invoice: string | null
  trial_end: number | null
  discounts: unknown[]
  items: { data: Array<{ id: string; price: StripePrice; quantity: number; discounts: unknown[]; current_period_start?: number; current_period_end?: number }> }
  schedule: StripeSchedule | null
}

type StripeCtx = { secretKey: string }

function stripeFailure(what: string, data: Record<string, unknown>): ServiceError {
  const message = (data['error'] as { message?: string } | undefined)?.message
  return err('BAD_GATEWAY', what, message)
}

// A schedule fresh from the subscription has a single phase, and one whose
// switch already happened has the running plan last; comparing the last phase
// against the running plan reads both as "nothing pending".
export function scheduledPlanFromSchedule(
  schedule: StripeSchedule | null,
  currentPlan: PaidPlanTier,
): PaidPlanTier | null {
  const price = schedule?.phases.at(-1)?.items[0]?.price
  const plan = price ? planFromMetadata(price.metadata) : null
  return plan !== null && plan !== currentPlan ? plan : null
}

// The last phase on the running plan: the switch already ran, or the schedule
// is fresh from the subscription. A price without plan metadata is not this.
export function nothingLeftToSwitch(schedule: StripeSchedule, currentPlan: PaidPlanTier): boolean {
  const price = schedule.phases.at(-1)?.items[0]?.price
  return price !== undefined && planFromMetadata(price.metadata) === currentPlan
}

export function planChangeDirection(current: PaidPlanTier, target: PaidPlanTier): 'upgrade' | 'downgrade' | 'same' {
  const delta = PAID_PLAN_TIERS.indexOf(target) - PAID_PLAN_TIERS.indexOf(current)
  return delta > 0 ? 'upgrade' : delta < 0 ? 'downgrade' : 'same'
}

async function fetchSubscription(subscriptionId: string, ctx: StripeCtx): Promise<ServiceResult<StripeSubscription>> {
  const res = await stripeApiRequest(
    'GET',
    `/subscriptions/${subscriptionId}?expand[]=schedule.phases.items.price`,
    null,
    ctx.secretKey,
  )
  if (!res.ok) return stripeFailure('Failed to load the subscription', res.data)
  return ok(res.data as StripeSubscription)
}

type CurrentPlan = { plan: PaidPlanTier; itemId: string; periodEnd: number }

function periodEndIso(periodEnd: number): string {
  return new Date(periodEnd * 1000).toISOString()
}

function currentPlanOf(sub: StripeSubscription): ServiceResult<CurrentPlan> {
  const item = sub.items.data.find((i) => planFromMetadata(i.price.metadata) !== null)
  const plan = item ? planFromMetadata(item.price.metadata) : null
  const { end } = periodFromSubscription(sub, sub.items)
  if (!item || !plan || end === undefined) {
    return err('INTERNAL_ERROR', 'Subscription is not on a LeadAce plan price', { subscriptionId: sub.id })
  }
  return ok({ plan, itemId: item.id, periodEnd: end })
}

async function readSubscriptionInfo(subscriptionId: string, ctx: StripeCtx): Promise<ServiceResult<SubscriptionInfo>> {
  const sub = await fetchSubscription(subscriptionId, ctx)
  if (!sub.ok) return sub
  const current = currentPlanOf(sub.value)
  if (!current.ok) return current
  return ok({
    periodEnd: periodEndIso(current.value.periodEnd),
    endsAt: sub.value.cancel_at === null ? null : new Date(sub.value.cancel_at * 1000).toISOString(),
    scheduledPlan: scheduledPlanFromSchedule(sub.value.schedule, current.value.plan),
  })
}

// See createCheckoutSession for the role of `_cloud`.
export async function getSubscriptionInfo(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: StripeCtx,
): Promise<ServiceResult<SubscriptionInfo>> {
  const subscriptionId = await requireStripeSubscription(db, tenantId)
  if (!subscriptionId.ok) return subscriptionId
  return readSubscriptionInfo(subscriptionId.value, ctx)
}

async function releaseSchedule(scheduleId: string, ctx: StripeCtx): Promise<ServiceResult<undefined>> {
  const res = await stripeApiRequest('POST', `/subscription_schedules/${scheduleId}/release`, null, ctx.secretKey)
  if (!res.ok) return stripeFailure('Failed to cancel the scheduled plan change', res.data)
  return ok(undefined)
}

type StripePaymentIntent = {
  status: string
  client_secret: string | null
  last_payment_error: { type?: string } | null
}

type Authenticate = { kind: 'authenticate'; clientSecret: string }

// An upgrade Stripe holds pending: a payment waiting on the bank is handed to
// the person; anything else is refused, and the caller drops the upgrade.
export function pendingUpgradeOutcome(intent: StripePaymentIntent | null): Authenticate | { kind: 'refused'; declined: boolean } {
  if (intent?.status === 'requires_action' && intent.client_secret) {
    return { kind: 'authenticate', clientSecret: intent.client_secret }
  }
  return { kind: 'refused', declined: intent?.last_payment_error?.type === 'card_error' }
}

// One message for every decline: the bank's reason is not the person's to act
// on, and a reason such as a stolen card is not shown at all.
const CARD_DECLINED = err('BAD_GATEWAY', 'Your card was declined', 'Your card was declined. Update the card under Manage subscription, then try again.')

// An upgrade starts a new monthly period now (`billing_cycle_anchor=now`), so
// the allowance counts afresh from today and is never bought for the last
// days of a period; `always_invoice` charges the new month today, less the
// unused part of the old plan. The person is here, so it is charged on
// session: `pending_if_incomplete` applies it only once that charge is paid,
// which lets the bank ask for 3-D Secure.
async function upgradeNow(sub: StripeSubscription, current: CurrentPlan, priceId: string, ctx: StripeCtx): Promise<ServiceResult<{ kind: 'applied' } | Authenticate>> {
  const res = await stripeApiRequest('POST', `/subscriptions/${sub.id}`, {
    'items[0][id]': current.itemId,
    'items[0][price]': priceId,
    'billing_cycle_anchor': 'now',
    'proration_behavior': 'always_invoice',
    'payment_behavior': 'pending_if_incomplete',
    'expand[0]': 'latest_invoice.payments',
  }, ctx.secretKey)
  // The webhook mirrors whatever Stripe did with an answer that never came.
  if (!res.ok && res.unknown) return err('BAD_GATEWAY', 'The plan change could not be confirmed', 'Reload the plans page to see your plan.')
  if (!res.ok) return isCardDecline(res.data) ? CARD_DECLINED : stripeFailure('The plan change was not applied', res.data)
  const updated = res.data as {
    pending_update: unknown
    latest_invoice: { id: string; payments?: { data: Array<{ payment: { payment_intent?: string } }> } } | null
  }
  if (updated.pending_update === null) return ok({ kind: 'applied' })
  const intentId = updated.latest_invoice?.payments?.data[0]?.payment.payment_intent
  const intent = intentId ? await stripeApiRequest('GET', `/payment_intents/${intentId}`, null, ctx.secretKey) : null
  const outcome = pendingUpgradeOutcome(intent?.ok ? (intent.data as StripePaymentIntent) : null)
  if (outcome.kind === 'authenticate') return ok(outcome)
  const dropped = await dropPendingUpgrade(updated.latest_invoice?.id ?? null, ctx)
  if (!dropped.ok) return dropped
  return outcome.declined ? CARD_DECLINED : err('BAD_GATEWAY', 'The plan change was not applied')
}

// Voiding the invoice of a pending update drops the update with it (Stripe
// drops one itself after 23 hours). Nothing was paid, so nothing is lost.
async function dropPendingUpgrade(invoiceId: string | null, ctx: StripeCtx): Promise<ServiceResult<undefined>> {
  if (!invoiceId) return err('INTERNAL_ERROR', 'A pending upgrade has no invoice')
  const res = await stripeApiRequest('POST', `/invoices/${invoiceId}/void`, null, ctx.secretKey)
  if (!res.ok) return stripeFailure('Failed to drop the unfinished upgrade', res.data)
  return ok(undefined)
}

// A subscription a schedule manages is changed through the schedule, which
// cannot refuse a declined charge, so an upgrade never runs with one attached.
// A pending switch is the person's to drop first (as the Customer Portal
// requires); a schedule with nothing left to switch (its switch ran, or it
// was left half made) is released, as a downgrade does, which loses nothing.
async function clearScheduleForUpgrade(schedule: StripeSchedule, currentPlan: PaidPlanTier, ctx: StripeCtx): Promise<ServiceResult<undefined>> {
  if (nothingLeftToSwitch(schedule, currentPlan)) return releaseSchedule(schedule.id, ctx)
  const pending = scheduledPlanFromSchedule(schedule, currentPlan)
  const switchAt = schedule.phases.at(-1)?.start_date
  if (!pending || switchAt === undefined) {
    console.error('CRITICAL plan change: a schedule switches to a price without plan metadata; upgrade refused (fix the price metadata)', { scheduleId: schedule.id })
    return err('CONFLICT', 'A plan switch is scheduled', 'The scheduled switch could not be read. Contact support to change the plan.')
  }
  return err(
    'CONFLICT',
    'A plan switch is scheduled',
    `Your switch to ${tierName(pending)} on ${new Date(switchAt * 1000).toISOString().slice(0, 10)} is scheduled. To upgrade, keep ${tierName(currentPlan)} on the plans page first.`,
  )
}

function tierName(plan: PaidPlanTier): string {
  return plan.charAt(0).toUpperCase() + plan.slice(1)
}

// The Customer Portal can only switch prices within one product, so a
// scheduled switch is driven through the API here.
async function downgradeAtPeriodEnd(sub: StripeSubscription, plan: CurrentPlan, priceId: string, ctx: StripeCtx): Promise<ServiceResult<undefined>> {
  // The phase restated below carries one price at quantity one and automatic
  // tax only, and Stripe unsets whatever the restatement omits.
  const item = sub.items.data[0]
  if (sub.trial_end !== null || sub.discounts.length > 0 || sub.items.data.length !== 1 || item?.quantity !== 1 || item.discounts.length > 0) {
    return err('CONFLICT', 'Plan change is not available here', 'This subscription carries a trial, a discount or an extra item. Contact support to change the plan.')
  }
  // A schedule whose switch already ran is about to be released by the
  // webhook, so it is not rewritten; a fresh one replaces it.
  const reusable = sub.schedule && scheduledPlanFromSchedule(sub.schedule, plan.plan) ? sub.schedule : null
  if (sub.schedule && !reusable) {
    const released = await releaseSchedule(sub.schedule.id, ctx)
    if (!released.ok) return released
  }
  const schedule = reusable ? attachedSchedule(reusable) : await createSchedule(sub.id, ctx)
  if (!schedule.ok) return schedule
  const { id, current } = schedule.value
  const taxEnabled = current.taxEnabled ? 'true' : 'false'
  const updated = await stripeApiRequest('POST', `/subscription_schedules/${id}`, {
    'end_behavior': 'release',
    'phases[0][items][0][price]': current.priceId,
    'phases[0][items][0][quantity]': '1',
    'phases[0][start_date]': String(current.start_date),
    'phases[0][end_date]': String(current.end_date),
    'phases[0][automatic_tax][enabled]': taxEnabled,
    'phases[1][items][0][price]': priceId,
    'phases[1][items][0][quantity]': '1',
    'phases[1][duration][interval]': 'month',
    'phases[1][duration][interval_count]': '1',
    'phases[1][proration_behavior]': 'none',
    'phases[1][automatic_tax][enabled]': taxEnabled,
  }, ctx.secretKey)
  if (!updated.ok) {
    // A failed answer can hide an applied switch (one that could not be read),
    // so the schedule as Stripe now has it decides; a fresh one Stripe shows
    // without the switch is released, one it cannot show is left as it is.
    const now = await stripeApiRequest('GET', `/subscription_schedules/${id}`, null, ctx.secretKey)
    const phases = now.data['phases'] as Array<{ items: Array<{ price: string }> }> | undefined
    if (now.ok && phases?.at(-1)?.items[0]?.price === priceId) return ok(undefined)
    if (now.ok && !reusable) await releaseSchedule(id, ctx)
    return stripeFailure('Failed to schedule the plan change', updated.data)
  }
  return ok(undefined)
}

type CurrentPhase = { priceId: string; start_date: number; end_date: number; taxEnabled: boolean }
type ScheduleTarget = { id: string; current: CurrentPhase }

function scheduleTarget(id: string, phase: StripeSchedulePhase<unknown>, priceId: string): ScheduleTarget {
  return {
    id,
    current: { priceId, start_date: phase.start_date, end_date: phase.end_date, taxEnabled: phase.automatic_tax?.enabled === true },
  }
}

function attachedSchedule(schedule: StripeSchedule): ServiceResult<ScheduleTarget> {
  const phase = schedule.phases.find((p) => p.start_date === schedule.current_phase?.start_date)
  const price = phase?.items[0]?.price
  if (!phase || !price) return err('INTERNAL_ERROR', 'Subscription schedule has no current phase', { scheduleId: schedule.id })
  return ok(scheduleTarget(schedule.id, phase, price.id))
}

async function createSchedule(subscriptionId: string, ctx: StripeCtx): Promise<ServiceResult<ScheduleTarget>> {
  const created = await stripeApiRequest('POST', '/subscription_schedules', { from_subscription: subscriptionId }, ctx.secretKey)
  if (!created.ok) return stripeFailure('Failed to schedule the plan change', created.data)
  const schedule = created.data as CreatedStripeSchedule
  const phase = schedule.phases[0]
  const priceId = phase?.items[0]?.price
  if (!phase || !priceId) {
    await releaseSchedule(schedule.id, ctx)
    return err('INTERNAL_ERROR', 'Subscription schedule has no current phase', { scheduleId: schedule.id })
  }
  return ok(scheduleTarget(schedule.id, phase, priceId))
}

export async function changePlan(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: StripeCtx,
  body: PlanChangeBody,
): Promise<ServiceResult<PlanChangeResult>> {
  const subscriptionId = await requireStripeSubscription(db, tenantId)
  if (!subscriptionId.ok) return subscriptionId
  await lockTenant(db, tenantId)

  const target = await planOfPrice(body.priceId, ctx.secretKey)
  if (!target.ok) return target

  const fetched = await fetchSubscription(subscriptionId.value, ctx)
  if (!fetched.ok) return fetched
  const sub = fetched.value
  const current = currentPlanOf(sub)
  if (!current.ok) return current

  if (sub.status !== 'active' && sub.status !== 'trialing') {
    return err('CONFLICT', 'Subscription is not active', `Its status is ${sub.status}.`)
  }
  if (sub.cancel_at !== null) {
    return err('CONFLICT', 'Subscription is set to cancel', 'Reactivate it in the billing portal before changing the plan.')
  }
  if (current.value.plan !== body.fromPlan || periodEndIso(current.value.periodEnd) !== body.periodEnd) {
    return err('CONFLICT', 'Plan changed since the page loaded', 'Reload the page and try again.')
  }
  const direction = planChangeDirection(current.value.plan, target.value)
  if (direction === 'same') return err('CONFLICT', 'Already on this plan')

  // An upgrade left waiting on its bank (the page closed mid-authentication)
  // gives way to the change asked for now.
  if (sub.pending_update !== null) {
    const dropped = await dropPendingUpgrade(sub.latest_invoice, ctx)
    if (!dropped.ok) return dropped
  }

  if (direction === 'upgrade' && sub.schedule) {
    const cleared = await clearScheduleForUpgrade(sub.schedule, current.value.plan, ctx)
    if (!cleared.ok) return cleared
  }
  if (direction === 'upgrade') {
    const upgraded = await upgradeNow(sub, current.value, body.priceId, ctx)
    if (!upgraded.ok) return upgraded
    if (upgraded.value.kind === 'authenticate') return ok({ status: 'requires_action', clientSecret: upgraded.value.clientSecret })
  } else {
    const scheduled = await downgradeAtPeriodEnd(sub, current.value, body.priceId, ctx)
    if (!scheduled.ok) return scheduled
  }
  const info = await readSubscriptionInfo(sub.id, ctx)
  return info.ok ? ok({ status: 'done', subscription: info.value }) : info
}

// Serializes plan changes per tenant, so a request classified as an upgrade
// cannot apply as an immediate, credited downgrade. The key is this feature's
// own so a change in flight never holds up a send on credits.
async function lockTenant(db: Db, tenantId: TenantId): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:plan-change`}))`)
}

export async function cancelPlanChange(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: StripeCtx,
): Promise<ServiceResult<SubscriptionInfo>> {
  const subscriptionId = await requireStripeSubscription(db, tenantId)
  if (!subscriptionId.ok) return subscriptionId
  await lockTenant(db, tenantId)
  const fetched = await fetchSubscription(subscriptionId.value, ctx)
  if (!fetched.ok) return fetched
  if (!fetched.value.schedule) return err('NOT_FOUND', 'No plan change is scheduled')
  const released = await releaseSchedule(fetched.value.schedule.id, ctx)
  if (!released.ok) return released
  return readSubscriptionInfo(subscriptionId.value, ctx)
}
