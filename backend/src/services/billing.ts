import { z } from 'zod'
import { eq, sql } from 'drizzle-orm'
import { tenantPlans } from '../db/schema'
import {
  getTenantPlan,
  getPlanLimits,
  getRemainingProspectQuotaForPlan,
  countTenantProspects,
  planFromMetadata,
  subscriptionEnded,
  type MainChatQuota,
  type ProspectQuota,
  type PlanLimits,
  type PlanTier,
  type PaidPlanTier,
} from './plan-limits'
import { getMainChatQuota } from './chat-rate-limit'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { stripeApiRequest, stripeErrorCode } from './stripe-api'
import type { Edition, CloudEdition } from '../domain/edition'

export const checkoutBodySchema = z.object({
  priceId: z.string().min(1),
  successUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
})
export type CheckoutBody = z.infer<typeof checkoutBodySchema>

export const portalBodySchema = z.object({
  returnUrl: z.url().optional(),
})
export type PortalBody = z.infer<typeof portalBodySchema>

export type PlanInfo = {
  plan: PlanTier
  limits: {
    maxProjects: number | null
    maxProspects: number | null
  }
  quota: ProspectQuota
  // Stored prospects against the storage cap; absent when uncapped.
  prospects?: { used: number; remaining: number; limit: number }
  chat: MainChatQuota
  // A Stripe customer exists, so the billing portal opens — also on free,
  // where a failed renewal or a cancellation leaves the tenant.
  billingPortal: boolean
}

export async function getPlanInfo(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<ServiceResult<PlanInfo>> {
  const tenantPlan = await getTenantPlan(db, tenantId, edition)
  const limits: PlanLimits = getPlanLimits(tenantPlan.plan)

  const [quota, prospectCount, chat, customer] = await Promise.all([
    getRemainingProspectQuotaForPlan(db, tenantId, tenantPlan),
    limits.maxProspects !== null ? countTenantProspects(db, tenantId) : Promise.resolve(null),
    getMainChatQuota(db, tenantId, tenantPlan),
    requireStripeCustomer(db, tenantId),
  ])

  const result: PlanInfo = {
    plan: tenantPlan.plan,
    limits: {
      maxProjects: limits.maxProjects,
      maxProspects: limits.maxProspects,
    },
    quota,
    chat,
    billingPortal: customer.ok,
  }

  if (limits.maxProspects !== null && prospectCount !== null) {
    result.prospects = {
      used: prospectCount,
      remaining: Math.max(0, limits.maxProspects - prospectCount),
      limit: limits.maxProspects,
    }
  }

  return ok(result)
}

// The paid tier an active plan price stands for. Any other price (archived, a
// credit pack, none by that id) is refused as input; a read that failed is
// Stripe's failure, not the caller's.
export async function planOfPrice(priceId: string, secretKey: string): Promise<ServiceResult<PaidPlanTier>> {
  const price = await stripeApiRequest('GET', `/prices/${encodeURIComponent(priceId)}`, null, secretKey)
  const missing = stripeErrorCode(price.data) === 'resource_missing'
  if (!price.ok && !missing) return err('BAD_GATEWAY', 'Failed to load the price', price.data)
  const plan = price.ok && price.data['active'] === true
    ? planFromMetadata(price.data['metadata'] as Record<string, string> | undefined)
    : null
  return plan ? ok(plan) : err('INVALID_INPUT', 'Unknown plan price')
}

// A customer's subscriptions list as a new Checkout sees it: any subscription
// that has not ended (past_due, unpaid and a payment still processing have
// not) means another one would bill the tenant twice.
export type CustomerSubscriptions = 'live' | 'none' | 'unreadable'

export function customerSubscriptions(read: { ok: boolean; data: Record<string, unknown> }): CustomerSubscriptions {
  const list = read.data['data']
  if (!read.ok || !Array.isArray(list)) return 'unreadable'
  const live = list.some((sub: { status?: unknown }) => !subscriptionEnded(sub.status))
  return live ? 'live' : 'none'
}

// One Stripe customer per tenant, made before its first Checkout, so every
// subscription the tenant starts lands on it and the check below sees them
// all, whether or not a webhook has landed. A fresh customer has none.
async function checkoutCustomer(db: Db, tenantId: TenantId, secretKey: string): Promise<ServiceResult<string>> {
  const stored = await requireStripeCustomer(db, tenantId)
  if (!stored.ok) return storeNewCustomer(db, tenantId, secretKey)
  const closed = await expireOpenCheckouts(stored.value, secretKey)
  if (!closed.ok) return closed
  const read = await stripeApiRequest(
    'GET',
    `/subscriptions?customer=${encodeURIComponent(stored.value)}&limit=100`,
    null,
    secretKey,
  )
  switch (customerSubscriptions(read)) {
    case 'none':
      return stored
    case 'live':
      return err(
        'CONFLICT',
        'A subscription already exists',
        'Your subscription is still open. Pay or cancel it under Manage subscription on the plans page.',
      )
    case 'unreadable': {
      // Loud on purpose: the usual cause is an operator error (a customer
      // deleted in the Dashboard, a test id under the live key), and nobody
      // can pay until it is fixed.
      console.error('CRITICAL checkout: cannot read the tenant\'s Stripe subscriptions', { tenantId, code: stripeErrorCode(read.data) })
      return err('BAD_GATEWAY', 'Failed to load your subscriptions', read.data)
    }
  }
}

// A new Checkout replaces the customer's open ones, so two tabs cannot each
// start a subscription. Run before the subscriptions check: once expired, a
// session can no longer add one. One that cannot be expired may be paying
// right now, so the new Checkout is refused.
async function expireOpenCheckouts(customerId: string, secretKey: string): Promise<ServiceResult<undefined>> {
  const open = await stripeApiRequest(
    'GET',
    `/checkout/sessions?customer=${encodeURIComponent(customerId)}&status=open&limit=100`,
    null,
    secretKey,
  )
  const list = open.data['data']
  if (!open.ok || !Array.isArray(list)) return err('BAD_GATEWAY', 'Failed to load your open checkouts', open.data)
  for (const session of list as Array<{ id: string }>) {
    const expired = await stripeApiRequest('POST', `/checkout/sessions/${session.id}/expire`, null, secretKey)
    if (!expired.ok) return err('BAD_GATEWAY', 'Failed to close an earlier checkout', expired.data)
  }
  return ok(undefined)
}

// A concurrent first Checkout may have stored its own customer; the stored one wins.
async function storeNewCustomer(db: Db, tenantId: TenantId, secretKey: string): Promise<ServiceResult<string>> {
  const created = await stripeApiRequest('POST', '/customers', { 'metadata[leadace_tenant_id]': tenantId }, secretKey)
  if (!created.ok) return err('BAD_GATEWAY', 'Failed to create the billing customer', created.data)
  const [row] = await db
    .insert(tenantPlans)
    .values({ tenantId, stripeCustomerId: created.data['id'] as string })
    .onConflictDoUpdate({
      target: tenantPlans.tenantId,
      set: { stripeCustomerId: sql`COALESCE(${tenantPlans.stripeCustomerId}, excluded.stripe_customer_id)`, updatedAt: new Date() },
    })
    .returning({ customerId: tenantPlans.stripeCustomerId })
  return row?.customerId ? ok(row.customerId) : err('INTERNAL_ERROR', 'Failed to store the billing customer')
}

// `_cloud` is a compile-time witness that the caller has already passed
// requireCloudEdition. It is intentionally unused at runtime — its only job
// is to make the Stripe code path uncallable on self-hosted installs.
export async function createCheckoutSession(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: { secretKey: string; userId: string; origin: string },
  body: CheckoutBody,
): Promise<ServiceResult<{ url: unknown }>> {
  const plan = await planOfPrice(body.priceId, ctx.secretKey)
  if (!plan.ok) return plan
  // Held until the request commits, so a second Checkout for the tenant sees
  // this one's session and expires it.
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${tenantId}:checkout`}))`)
  const customer = await checkoutCustomer(db, tenantId, ctx.secretKey)
  if (!customer.ok) return customer

  const successUrl = body.successUrl ?? `${ctx.origin}/plans?checkout=success`
  const cancelUrl = body.cancelUrl ?? `${ctx.origin}/plans?checkout=cancel`

  // Stripe Tax: automatic_tax computes tax from the buyer's billing address.
  // billing_address_collection=required upgrades the default minimum-fields
  // collection to a full billing address (for invoice records). With an
  // existing `customer`, Stripe needs customer_update to save the address and
  // the tax-ID name onto it.
  // tax_id_collection[enabled] is field-optional for buyers; B2B customers
  // can enter a VAT/GST/business number, B2C can skip it.
  const { ok: stripeOk, data } = await stripeApiRequest('POST', '/checkout/sessions', {
    'mode': 'subscription',
    'locale': 'auto',
    'line_items[0][price]': body.priceId,
    'line_items[0][quantity]': '1',
    'client_reference_id': ctx.userId,
    'success_url': successUrl,
    'cancel_url': cancelUrl,
    'automatic_tax[enabled]': 'true',
    'billing_address_collection': 'required',
    'tax_id_collection[enabled]': 'true',
    'customer': customer.value,
    'customer_update[address]': 'auto',
    'customer_update[name]': 'auto',
  }, ctx.secretKey)

  if (!stripeOk) {
    return err('INTERNAL_ERROR', 'Failed to create checkout session', data)
  }

  return ok({ url: data['url'] })
}

// The tenant's Stripe Customer, made at its first Checkout; a manually seeded
// paid tier has none, so the portal and credits are unavailable to it.
export async function requireStripeCustomer(db: Db, tenantId: TenantId): Promise<ServiceResult<string>> {
  const [row] = await db
    .select({ stripeCustomerId: tenantPlans.stripeCustomerId })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)
  if (!row?.stripeCustomerId) return err('NOT_FOUND', 'No active subscription found')
  return ok(row.stripeCustomerId)
}

export async function requireStripeSubscription(db: Db, tenantId: TenantId): Promise<ServiceResult<string>> {
  const [row] = await db
    .select({ stripeSubscriptionId: tenantPlans.stripeSubscriptionId })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)
  if (!row?.stripeSubscriptionId) return err('NOT_FOUND', 'No active subscription found')
  return ok(row.stripeSubscriptionId)
}

// See createCheckoutSession for the role of `_cloud`.
export async function createPortalSession(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: { secretKey: string; origin: string },
  body: PortalBody,
): Promise<ServiceResult<{ url: unknown }>> {
  const customer = await requireStripeCustomer(db, tenantId)
  if (!customer.ok) return customer

  const returnUrl = body.returnUrl ?? `${ctx.origin}/plans`

  const { ok: stripeOk, data } = await stripeApiRequest('POST', '/billing_portal/sessions', {
    customer: customer.value,
    return_url: returnUrl,
  }, ctx.secretKey)

  if (!stripeOk) {
    return err('INTERNAL_ERROR', 'Failed to create portal session', data)
  }

  return ok({ url: data['url'] })
}
