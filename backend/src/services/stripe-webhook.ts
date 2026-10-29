import { eq, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { runWithRls } from '../db/rls'
import { tenantPlans, tenantMembers } from '../db/schema'
import { timingSafeEqual } from '../domain/timing-safe'
import { stripeApiRequest } from './stripe-api'
import { planFromMetadata, subscriptionEnded, type PaidPlanTier, type PlanTier } from './plan-limits'
import { abandonPendingTopUp, settleCreditPurchase, settleTopUpFailedEvent, settleTopUpPaidEvent } from './credits'

// Lives in the service tier (not domain) because crypto.subtle and the wall
// clock are restricted to the service layer per backend-architecture.md.
export async function verifyStripeSignature(
  payload: string,
  sigHeader: string,
  secret: string,
  toleranceSec = 300,
): Promise<boolean> {
  const parts = sigHeader.split(',').reduce(
    (acc, part) => {
      const [k, v] = part.split('=')
      if (k === 't') acc.timestamp = v!
      if (k === 'v1') acc.signatures.push(v!)
      return acc
    },
    { timestamp: '', signatures: [] as string[] },
  )

  if (!parts.timestamp || parts.signatures.length === 0) return false

  const ts = parseInt(parts.timestamp, 10)
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${parts.timestamp}.${payload}`),
  )
  const expected = Array.from(new Uint8Array(signed))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  // Per-signature compare is constant-time so a mismatch's byte position
  // can't leak via timing. Outer .some() short-circuit is safe because each
  // candidate sig is attacker-supplied — "which one matched" leaks nothing.
  return parts.signatures.some((sig) => timingSafeEqual(sig, expected))
}

export type StripeSubscriptionItems = {
  data: Array<{
    price: { metadata: Record<string, string> }
    current_period_start?: number
    current_period_end?: number
  }>
} | undefined

export type StripePeriod = { start: number | undefined; end: number | undefined }

// API 2025-03-31 (Basil) moved the period off the subscription onto its
// items; read the root first, then the plan item, so either version works.
export function periodFromSubscription(sub: Record<string, unknown>, items: StripeSubscriptionItems): StripePeriod {
  const rootStart = sub['current_period_start'] as number | undefined
  const rootEnd = sub['current_period_end'] as number | undefined
  if (rootStart !== undefined && rootEnd !== undefined) return { start: rootStart, end: rootEnd }
  const planItem = items?.data.find((item) => planFromMetadata(item.price.metadata) !== null)
  return { start: planItem?.current_period_start, end: planItem?.current_period_end }
}

// Only the plan price carries metadata.plan, and it is not necessarily the
// subscription's first item.
export function planFromSubscriptionItems(items: StripeSubscriptionItems): PaidPlanTier | null {
  for (const item of items?.data ?? []) {
    const plan = planFromMetadata(item.price.metadata)
    if (plan) return plan
  }
  return null
}

// Async payment methods can leave checkout.session.completed in
// 'processing'/'incomplete', so the paid tier is granted only when the
// subscription status confirms it.
export function effectivePlanFromStatus(
  status: string | undefined,
  plan: PaidPlanTier | null,
): PlanTier {
  return (status === 'active' || status === 'trialing') && plan ? plan : 'free'
}

// A live subscription on a price without plan metadata means our Stripe
// config drifted (a Dashboard edit, a wrong price). Nothing is written and
// nothing is undone: the event fails, so it stays visible and is redelivered
// once the price is fixed.
export function assertPlanPrice(
  status: string | undefined,
  plan: PaidPlanTier | null,
  context: { tenantId: string; subscriptionId: string; items: StripeSubscriptionItems },
): void {
  if ((status === 'active' || status === 'trialing') && !plan) {
    console.error('CRITICAL subscription on a price without plan metadata; nothing written (fix the price metadata)', context)
    throw new Error(`subscription ${context.subscriptionId} is on a price without plan metadata`)
  }
}

// A handler throws only where a redelivery can succeed (a Stripe call
// failed, a price awaits its plan metadata); the webhook then answers non-2xx
// and Stripe retries for up to 3 days. Anything else we can't handle is logged
// and ignored so the queue drains.
export type StripeEvent = {
  type: string
  data: { object: Record<string, unknown> }
}

export async function handleStripeEvent(
  db: Db,
  secretKey: string,
  event: StripeEvent,
): Promise<void> {
  switch (event.type) {
    // mode=payment is a credit pack (services/credits.ts); mode=subscription
    // a plan. An async payment method completes the session unpaid and
    // confirms with async_payment_succeeded.
    case 'checkout.session.completed':
      if (event.data.object['mode'] === 'payment') await settleCreditPurchase(db, event.data.object)
      else await handleCheckoutSessionCompleted(db, secretKey, event.data.object)
      return
    case 'checkout.session.async_payment_succeeded':
      if (event.data.object['mode'] === 'payment') await settleCreditPurchase(db, event.data.object)
      return
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await handleSubscriptionEvent(db, secretKey, event.data.object)
      return
    // A credit top-up invoice (LeadAce metadata) settles the ledger. Renewal
    // invoices are observation-only: plan state is mirrored from
    // customer.subscription.updated (which fires on every renewal as
    // current_period_start/end change), so log for billing visibility and
    // don't touch tenant_plans.
    case 'invoice.paid':
      if (!(await settleTopUpPaidEvent(db, event.data.object))) logInvoicePaid(event.data.object)
      return
    case 'invoice.payment_failed':
      if (!(await settleTopUpFailedEvent(db, event.data.object))) logInvoicePaymentFailed(event.data.object)
      return
    default:
      return
  }
}

// The event that ties a Stripe customer to our user. Checkout is opened on the
// tenant's customer, but a session from before customers were made up front
// brought its own: it is kept only when the tenant has none, so a late event
// never repoints a tenant at another customer.
async function handleCheckoutSessionCompleted(
  db: Db,
  secretKey: string,
  session: Record<string, unknown>,
): Promise<void> {
  const userId = session['client_reference_id'] as string | null
  const customerId = session['customer'] as string | null

  if (!userId || !customerId) {
    console.error('checkout.session.completed: missing required fields', { userId, customerId })
    return
  }

  const [member] = await db
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, userId))
    .limit(1)

  if (!member) {
    console.error('checkout.session.completed: no tenant found for user', userId)
    return
  }

  const [linked] = await db
    .insert(tenantPlans)
    .values({ tenantId: member.tenantId, stripeCustomerId: customerId })
    .onConflictDoUpdate({
      target: tenantPlans.tenantId,
      set: { stripeCustomerId: sql`COALESCE(${tenantPlans.stripeCustomerId}, excluded.stripe_customer_id)`, updatedAt: new Date() },
    })
    .returning({ customerId: tenantPlans.stripeCustomerId })
  if (!linked?.customerId) throw new Error(`failed to link customer ${customerId} to tenant ${member.tenantId}`)
  if (linked.customerId !== customerId) {
    console.error('CRITICAL checkout.session.completed: the session is on another customer than the tenant\'s; mirroring the tenant\'s', {
      tenantId: member.tenantId, sessionCustomer: customerId, tenantCustomer: linked.customerId,
    })
  }
  await mirrorCustomer(db, secretKey, member.tenantId, linked.customerId)
}

async function handleSubscriptionEvent(
  db: Db,
  secretKey: string,
  fromEvent: Record<string, unknown>,
): Promise<void> {
  const customerId = fromEvent['customer']
  const [row] = typeof customerId === 'string'
    ? await db
        .select({ tenantId: tenantPlans.tenantId, customerId: tenantPlans.stripeCustomerId })
        .from(tenantPlans)
        .where(eq(tenantPlans.stripeCustomerId, customerId))
        .limit(1)
    : []

  if (!row?.customerId) {
    console.error('subscription event: no tenant found for customer', { customerId, subscriptionId: fromEvent['id'] })
    return
  }
  await mirrorCustomer(db, secretKey, row.tenantId, row.customerId)
}

// Two events for one tenant can run at once (a lapse and its recovery seconds
// apart): each reads Stripe and writes under this lock, so the later read is
// the one that lands last. A holder waits on Stripe for one call (its timeout
// and retries); a waiter that gives up first fails its event, and Stripe
// redelivers it.
function underSubscriptionLock<T>(db: Db, tenantId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return runWithRls(db, tenantId, async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '15s'`)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:subscription`}))`)
    return fn(tx)
  })
}

type ListedSubscription = Record<string, unknown>

// The customer's subscriptions that have not ended (past_due and unpaid have
// not), the one the tenant holds first. Checkout refuses a second, so more
// than one is an incident; the paying one, then the newest, is held.
export function rankLiveSubscriptions(subs: ListedSubscription[]): ListedSubscription[] {
  const paying = (sub: ListedSubscription) => sub['status'] === 'active' || sub['status'] === 'trialing'
  return subs
    .filter((sub) => !subscriptionEnded(sub['status']))
    .sort((a, b) => Number(paying(b)) - Number(paying(a)) || Number(b['created']) - Number(a['created']))
}

async function liveSubscriptions(customerId: string, secretKey: string): Promise<ListedSubscription[]> {
  const res = await stripeApiRequest('GET', `/subscriptions?customer=${encodeURIComponent(customerId)}&limit=100`, null, secretKey)
  const list = res.data['data']
  if (!res.ok || !Array.isArray(list)) throw new Error(`failed to list subscriptions of ${customerId}: ${JSON.stringify(res.data)}`)
  return rankLiveSubscriptions(list as ListedSubscription[])
}

// Whatever the event, the tenant's row is written from its customer's
// subscriptions as Stripe has them now: Stripe does not order its events and
// redelivers a failed one for days, and a failed read throws so the event
// comes back. The row holds a subscription until it ends, so free with one
// held is a subscription Stripe has not been paid for (domain/attention). With
// none left the auto top-up consent goes too: a later subscription starts with
// it off rather than charging a new card on an old yes.
async function mirrorCustomer(db: Db, secretKey: string, tenantId: string, customerId: string): Promise<void> {
  const mirrored = await underSubscriptionLock(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({ plan: tenantPlans.plan })
      .from(tenantPlans)
      .where(eq(tenantPlans.tenantId, tenantId))
      .limit(1)
    // Never demote 'unlimited' — a tenant on this tier shouldn't have a
    // Stripe subscription, but refuse to overwrite if one is attached.
    if (row?.plan === 'unlimited') {
      console.error('CRITICAL subscription event: tenant on unlimited plan has a Stripe customer; refusing to update', { tenantId, customerId })
      return null
    }

    const live = await liveSubscriptions(customerId, secretKey)
    if (live.length > 1) {
      console.error('CRITICAL subscription event: customer has more than one live subscription', { tenantId, customerId, subscriptionIds: live.map((sub) => sub['id']) })
    }
    const sub = live[0]
    if (!sub) {
      await tx
        .update(tenantPlans)
        .set({ plan: 'free', stripeSubscriptionId: null, autoTopUpEnabled: false, autoTopUpFailedAt: null, updatedAt: new Date() })
        .where(eq(tenantPlans.tenantId, tenantId))
      return { activePlan: 'free' as const, scheduleId: null }
    }

    const subscriptionId = sub['id'] as string
    const items = sub['items'] as StripeSubscriptionItems
    const plan = planFromSubscriptionItems(items)
    const status = sub['status'] as string
    assertPlanPrice(status, plan, { tenantId, subscriptionId, items })

    const activePlan = effectivePlanFromStatus(status, plan)
    const { start: periodStart, end: periodEnd } = periodFromSubscription(sub, items)
    await tx
      .update(tenantPlans)
      .set({
        plan: activePlan,
        stripeSubscriptionId: subscriptionId,
        currentPeriodStart: periodStart ? new Date(periodStart * 1000) : undefined,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(tenantPlans.tenantId, tenantId))
    return { activePlan, scheduleId: sub['schedule'] }
  })
  if (!mirrored) return
  // A lapsed or ended subscription has nothing to charge a top-up to, so an
  // invoice in flight is voided. Free holds no credits, so no new top-up
  // starts; after a lapse the setting stays for when the plan returns.
  if (mirrored.activePlan === 'free') await abandonPendingTopUp(db, tenantId, secretKey)
  if (typeof mirrored.scheduleId === 'string') await releaseScheduleAfterSwitch(mirrored.scheduleId, secretKey)

  console.log(`Tenant ${tenantId} plan updated to ${mirrored.activePlan}`)
}

export type StripeSchedulePhases = {
  current_phase: { start_date: number } | null
  phases: Array<{ start_date: number }>
}

// A schedule created from a subscription has its single, current phase as
// the last one until the downgrade phase is added; releasing at that moment
// would race that update.
export function isInFinalPhase(schedule: StripeSchedulePhases): boolean {
  return schedule.phases.length > 1 && schedule.current_phase?.start_date === schedule.phases.at(-1)?.start_date
}

// A scheduled downgrade (services/plan-change.ts) stays attached to the
// subscription for the whole phase it switched to, and the Customer Portal
// refuses to update or cancel a subscription with a schedule. Release it as
// soon as the switch has happened. A Stripe failure here throws so the
// webhook answers non-2xx and Stripe redelivers the event (the plan mirror
// above is idempotent); end_behavior=release is the last resort.
async function releaseScheduleAfterSwitch(scheduleId: string, secretKey: string): Promise<void> {
  const schedule = await stripeApiRequest('GET', `/subscription_schedules/${scheduleId}`, null, secretKey)
  if (!schedule.ok) throw new Error(`subscription.updated: failed to load schedule ${scheduleId}: ${JSON.stringify(schedule.data)}`)
  if (schedule.data['status'] !== 'active' || !isInFinalPhase(schedule.data as StripeSchedulePhases)) return
  const released = await stripeApiRequest('POST', `/subscription_schedules/${scheduleId}/release`, null, secretKey)
  if (!released.ok) throw new Error(`subscription.updated: failed to release schedule ${scheduleId}: ${JSON.stringify(released.data)}`)
}

function logInvoicePaid(invoice: Record<string, unknown>): void {
  const subscriptionId = (invoice['subscription'] as string | null) ?? null
  const amountPaid = (invoice['amount_paid'] as number | null) ?? null
  const currency = (invoice['currency'] as string | null) ?? null
  const billingReason = (invoice['billing_reason'] as string | null) ?? null
  console.log('invoice.paid', { subscriptionId, amountPaid, currency, billingReason })
}

function logInvoicePaymentFailed(invoice: Record<string, unknown>): void {
  const subscriptionId = (invoice['subscription'] as string | null) ?? null
  const attemptCount = (invoice['attempt_count'] as number | null) ?? null
  const nextPaymentAttempt = (invoice['next_payment_attempt'] as number | null) ?? null
  console.error('invoice.payment_failed', { subscriptionId, attemptCount, nextPaymentAttempt })
}
