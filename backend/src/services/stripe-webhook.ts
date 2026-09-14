import { eq } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { tenantPlans, tenantMembers } from '../db/schema'
import { timingSafeEqual } from '../domain/timing-safe'
import { stripeApiRequest } from './stripe-api'
import { PAID_PLAN_TIERS, type PaidPlanTier, type PlanTier } from './plan-limits'
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

export function planFromMetadata(metadata: Record<string, string> | undefined): PaidPlanTier | null {
  const plan = metadata?.['plan']
  return PAID_PLAN_TIERS.find((tier) => tier === plan) ?? null
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

// Used when we detect a critical configuration error after a successful
// Checkout — the user paid but we cannot deliver, so we undo the charge.
// Best-effort: logs CRITICAL but never throws (webhook must always return 200
// to stop Stripe retries).
async function cancelAndRefund(
  subscriptionId: string,
  sub: Record<string, unknown> | null,
  secretKey: string,
  context: string,
): Promise<void> {
  const cancel = await stripeApiRequest('DELETE', `/subscriptions/${subscriptionId}`, null, secretKey)
  if (!cancel.ok) {
    console.error(`CRITICAL ${context}: failed to cancel subscription`, { subscriptionId, error: cancel.data })
  } else {
    console.error(`CRITICAL ${context}: subscription canceled`, { subscriptionId })
  }

  let invoiceId = (sub?.['latest_invoice'] as string | null | undefined) ?? null
  if (!invoiceId) {
    const fetched = await stripeApiRequest('GET', `/subscriptions/${subscriptionId}`, null, secretKey)
    if (fetched.ok) invoiceId = (fetched.data['latest_invoice'] as string | null) ?? null
  }
  if (!invoiceId) {
    console.error(`CRITICAL ${context}: no invoice on subscription, nothing to refund`, { subscriptionId })
    return
  }

  const inv = await stripeApiRequest('GET', `/invoices/${invoiceId}`, null, secretKey)
  if (!inv.ok) {
    console.error(`CRITICAL ${context}: failed to fetch invoice`, { invoiceId, error: inv.data })
    return
  }
  const chargeId = inv.data['charge'] as string | null
  if (!chargeId) {
    console.error(`CRITICAL ${context}: no charge on invoice (likely $0 trial); skipping refund`, { invoiceId })
    return
  }

  const refund = await stripeApiRequest('POST', '/refunds', { charge: chargeId }, secretKey)
  if (!refund.ok) {
    console.error(`CRITICAL ${context}: refund failed`, { chargeId, error: refund.data })
  } else {
    console.error(`CRITICAL ${context}: refund issued`, { chargeId, refundId: refund.data['id'] })
  }
}

// Webhook always responds 200 (Stripe retries non-2xx for up to 3 days);
// anything we can't handle is logged and ignored so the queue drains.
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
      await handleSubscriptionUpdated(db, secretKey, event.data.object)
      return
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(db, secretKey, event.data.object)
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

async function handleCheckoutSessionCompleted(
  db: Db,
  secretKey: string,
  session: Record<string, unknown>,
): Promise<void> {
  const userId = session['client_reference_id'] as string | null
  const customerId = session['customer'] as string | null
  const subscriptionId = session['subscription'] as string | null

  if (!userId || !customerId || !subscriptionId) {
    console.error('checkout.session.completed: missing required fields', { userId, customerId, subscriptionId })
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

  const tenantId = member.tenantId

  // Unlimited tenants aren't expected to go through Checkout (UI hides
  // Upgrade); defensively abort so their special status is never overwritten.
  const [existingPlan] = await db
    .select({ plan: tenantPlans.plan })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)

  if (existingPlan?.plan === 'unlimited') {
    console.error(
      'CRITICAL checkout.session.completed: tenant is on unlimited plan, refusing to overwrite',
      { tenantId, userId, subscriptionId },
    )
    return
  }

  const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  })
  const sub = (await subRes.json()) as Record<string, unknown>
  const items = sub['items'] as StripeSubscriptionItems
  const plan = planFromSubscriptionItems(items)

  // Checkout completed against a Price with no valid plan metadata means our
  // Stripe configuration is broken (Dashboard edit, or wrong Price ID). User
  // paid but we can't map them to a tier — cancel and refund rather than guess.
  if (!plan) {
    console.error(
      'CRITICAL checkout.session.completed: missing or invalid plan metadata on price; cancelling subscription and refunding charge',
      { tenantId, userId, subscriptionId, items },
    )
    await cancelAndRefund(subscriptionId, sub, secretKey, 'checkout.session.completed')
    return
  }

  // checkout.session.completed can fire before the subscription is active —
  // async payment methods (ACH etc.) leave it in 'processing'/'incomplete', and
  // even card-only flows are not contractually guaranteed to be 'active' at
  // this point. Persist customer/subscription IDs (needed for the portal) but
  // only grant the paid tier when status is active/trialing; otherwise leave
  // plan as 'free' and let customer.subscription.updated promote it later.
  const status = sub['status'] as string | undefined
  const activePlan = effectivePlanFromStatus(status, plan)
  if (activePlan === 'free') {
    console.warn(
      'checkout.session.completed: subscription not yet active; persisting IDs only, plan will be promoted by subscription.updated',
      { tenantId, userId, subscriptionId, status },
    )
  }

  const { start: periodStart, end: periodEnd } = periodFromSubscription(sub, items)

  const now = new Date()
  await db
    .insert(tenantPlans)
    .values({
      tenantId,
      plan: activePlan,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      currentPeriodStart: periodStart ? new Date(periodStart * 1000) : now,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: tenantPlans.tenantId,
      set: {
        plan: activePlan,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        currentPeriodStart: periodStart ? new Date(periodStart * 1000) : now,
        currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : now,
        updatedAt: now,
      },
    })

  console.log(
    `Tenant ${tenantId} (user ${userId}) checkout completed: requested=${plan}, effective=${activePlan}, status=${status}`,
  )
}

async function handleSubscriptionUpdated(
  db: Db,
  secretKey: string,
  sub: Record<string, unknown>,
): Promise<void> {
  const subscriptionId = sub['id'] as string

  const [row] = await db
    .select({ tenantId: tenantPlans.tenantId, plan: tenantPlans.plan })
    .from(tenantPlans)
    .where(eq(tenantPlans.stripeSubscriptionId, subscriptionId))
    .limit(1)

  if (!row) {
    console.error('subscription.updated: no tenant found for subscription', subscriptionId)
    return
  }

  // Never demote 'unlimited' — defensive, a tenant on this tier shouldn't
  // have a Stripe subscription, but refuse to overwrite if one is attached.
  if (row.plan === 'unlimited') {
    console.error(
      'CRITICAL subscription.updated: tenant on unlimited plan has Stripe subscription; refusing to update',
      { tenantId: row.tenantId, subscriptionId },
    )
    return
  }

  const items = sub['items'] as StripeSubscriptionItems
  const plan = planFromSubscriptionItems(items)
  const status = sub['status'] as string
  const { start: periodStart, end: periodEnd } = periodFromSubscription(sub, items)

  // Active subscription with missing plan metadata means our Stripe config
  // drifted (Dashboard edit). Don't auto-cancel a running subscription
  // mid-period — leave the DB row intact and alert via logs.
  if ((status === 'active' || status === 'trialing') && !plan) {
    console.error(
      'CRITICAL subscription.updated: active subscription with missing plan metadata; not modifying DB (operator must fix Price metadata)',
      { tenantId: row.tenantId, subscriptionId, status, items },
    )
    return
  }

  const activePlan = effectivePlanFromStatus(status, plan)

  // A lapsed subscription (past_due, unpaid, …) has nothing to charge a
  // top-up to, so auto top-up goes off and any invoice in flight is voided.
  await db
    .update(tenantPlans)
    .set({
      plan: activePlan,
      currentPeriodStart: periodStart ? new Date(periodStart * 1000) : undefined,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : undefined,
      ...(activePlan === 'free' ? { autoTopUpEnabled: false, autoTopUpFailedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(tenantPlans.tenantId, row.tenantId))
  if (activePlan === 'free') await abandonPendingTopUp(db, row.tenantId, secretKey)

  console.log(`Tenant ${row.tenantId} plan updated to ${activePlan}`)
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

async function handleSubscriptionDeleted(
  db: Db,
  secretKey: string,
  sub: Record<string, unknown>,
): Promise<void> {
  const subscriptionId = sub['id'] as string

  const [row] = await db
    .select({ tenantId: tenantPlans.tenantId, plan: tenantPlans.plan })
    .from(tenantPlans)
    .where(eq(tenantPlans.stripeSubscriptionId, subscriptionId))
    .limit(1)

  if (!row) {
    console.error('subscription.deleted: no tenant found for subscription', subscriptionId)
    return
  }

  if (row.plan === 'unlimited') {
    console.error(
      'CRITICAL subscription.deleted: tenant on unlimited plan has Stripe subscription; refusing to downgrade to free',
      { tenantId: row.tenantId, subscriptionId },
    )
    return
  }

  // Auto top-up charged this subscription's payment method; the next one
  // starts with it off. The credit balance itself stays (credits never expire).
  await db
    .update(tenantPlans)
    .set({ plan: 'free', autoTopUpEnabled: false, autoTopUpFailedAt: null, updatedAt: new Date() })
    .where(eq(tenantPlans.tenantId, row.tenantId))
  await abandonPendingTopUp(db, row.tenantId, secretKey)

  console.log(`Subscription ${subscriptionId} deleted, tenant ${row.tenantId} downgraded to free`)
}
