import { z } from 'zod'
import { sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import type { CloudEdition } from '../domain/edition'
import { ok, err, type ServiceError, type ServiceResult } from './result'
import { stripeApiRequest } from './stripe-api'
import { requireStripeSubscription } from './billing'
import { PAID_PLAN_TIERS, type PaidPlanTier } from './plan-limits'
import { planFromMetadata, periodFromSubscription } from './stripe-webhook'

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
  cancelAtPeriodEnd: boolean
  // The plan a schedule switches to at the period end; null = none pending.
  scheduledPlan: PaidPlanTier | null
}

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
  cancel_at_period_end: boolean
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
    cancelAtPeriodEnd: sub.value.cancel_at_period_end,
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

// `always_invoice` charges the difference for the rest of the period now;
// `error_if_incomplete` leaves the subscription untouched when that charge is
// declined; `off_session` avoids a 3-D Secure step this call cannot complete.
async function upgradeNow(sub: StripeSubscription, current: CurrentPlan, priceId: string, ctx: StripeCtx): Promise<ServiceResult<undefined>> {
  const res = await stripeApiRequest('POST', `/subscriptions/${sub.id}`, {
    'items[0][id]': current.itemId,
    'items[0][price]': priceId,
    'proration_behavior': 'always_invoice',
    'payment_behavior': 'error_if_incomplete',
    'off_session': 'true',
  }, ctx.secretKey)
  if (!res.ok) return stripeFailure('The plan change was not applied', res.data)
  return ok(undefined)
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
    if (!reusable) await releaseSchedule(id, ctx)
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
): Promise<ServiceResult<SubscriptionInfo>> {
  const subscriptionId = await requireStripeSubscription(db, tenantId)
  if (!subscriptionId.ok) return subscriptionId
  await lockTenant(db, tenantId)

  const price = await stripeApiRequest('GET', `/prices/${body.priceId}`, null, ctx.secretKey)
  const target = price.ok && price.data['active'] === true
    ? planFromMetadata(price.data['metadata'] as Record<string, string> | undefined)
    : null
  if (!target) return err('INVALID_INPUT', 'Unknown plan price')

  const fetched = await fetchSubscription(subscriptionId.value, ctx)
  if (!fetched.ok) return fetched
  const sub = fetched.value
  const current = currentPlanOf(sub)
  if (!current.ok) return current

  if (sub.status !== 'active' && sub.status !== 'trialing') {
    return err('CONFLICT', 'Subscription is not active', `Its status is ${sub.status}.`)
  }
  if (sub.cancel_at_period_end) {
    return err('CONFLICT', 'Subscription is set to cancel', 'Reactivate it in the billing portal before changing the plan.')
  }
  if (current.value.plan !== body.fromPlan || periodEndIso(current.value.periodEnd) !== body.periodEnd) {
    return err('CONFLICT', 'Plan changed since the page loaded', 'Reload the page and try again.')
  }
  const direction = planChangeDirection(current.value.plan, target)
  if (direction === 'same') return err('CONFLICT', 'Already on this plan')

  // A pending switch stays attached while the change is made — Stripe keeps
  // the schedule in step with a direct update — so a failure leaves it as it was.
  const applied = direction === 'upgrade'
    ? await upgradeNow(sub, current.value, body.priceId, ctx)
    : await downgradeAtPeriodEnd(sub, current.value, body.priceId, ctx)
  if (!applied.ok) return applied
  // The upgrade is charged and in force by now; a schedule that could not be
  // released stays visible as a pending switch the user can keep or drop.
  if (direction === 'upgrade' && sub.schedule) {
    const released = await releaseSchedule(sub.schedule.id, ctx)
    if (!released.ok) console.error('plan-change: upgraded but failed to release the schedule', { subscriptionId: sub.id, scheduleId: sub.schedule.id, error: released.detail })
  }

  return readSubscriptionInfo(sub.id, ctx)
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
