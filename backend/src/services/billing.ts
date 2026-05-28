import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { tenantPlans } from '../db/schema'
import {
  getTenantPlan,
  getPlanLimits,
  getRemainingOutreachQuotaForPlan,
  countTenantProspects,
  type OutreachQuota,
  type PlanLimits,
  type PlanTier,
} from './plan-limits'
import type { Db } from '../db/connection'
import type { TenantId } from '../domain/ids'
import { ok, err, type ServiceResult } from './result'
import { stripeApiRequest } from './stripe-api'
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
    maxOutreachPerDay: number | null
    maxOutreachLifetime: number | null
    maxOutreachPerMonth: number | null
    maxProspects: number | null
  }
  outreach: OutreachQuota
  prospects?: { used: number; remaining: number; limit: number }
}

export async function getPlanInfo(
  db: Db,
  tenantId: TenantId,
  edition: Edition,
): Promise<ServiceResult<PlanInfo>> {
  const tenantPlan = await getTenantPlan(db, tenantId, edition)
  const limits: PlanLimits = getPlanLimits(tenantPlan.plan)

  const [quota, prospectCount] = await Promise.all([
    getRemainingOutreachQuotaForPlan(db, tenantId, tenantPlan),
    limits.maxProspects !== null ? countTenantProspects(db, tenantId) : Promise.resolve(null),
  ])

  const result: PlanInfo = {
    plan: tenantPlan.plan,
    limits: {
      maxProjects: limits.maxProjects,
      maxOutreachPerDay: limits.maxOutreachPerDay,
      maxOutreachLifetime: limits.maxOutreachLifetime,
      maxOutreachPerMonth: limits.maxOutreachPerMonth,
      maxProspects: limits.maxProspects,
    },
    outreach: quota,
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

// `_cloud` is a compile-time witness that the caller has already passed
// requireCloudEdition. It is intentionally unused at runtime — its only job
// is to make the Stripe code path uncallable on self-hosted installs.
export async function createCheckoutSession(
  _cloud: CloudEdition,
  ctx: { secretKey: string; userId: string; origin: string },
  body: CheckoutBody,
): Promise<ServiceResult<{ url: unknown }>> {
  const successUrl = body.successUrl ?? `${ctx.origin}/plans?checkout=success`
  const cancelUrl = body.cancelUrl ?? `${ctx.origin}/plans?checkout=cancel`

  // Stripe Tax: automatic_tax computes tax from the buyer's billing address.
  // billing_address_collection=required upgrades the default minimum-fields
  // collection to a full billing address (for invoice records). With no
  // `customer` param Stripe creates a new Customer and saves the address
  // automatically — `customer_update[address]` is not needed.
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
  }, ctx.secretKey)

  if (!stripeOk) {
    return err('INTERNAL_ERROR', 'Failed to create checkout session', data)
  }

  return ok({ url: data['url'] })
}

// See createCheckoutSession for the role of `_cloud`.
export async function createPortalSession(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  ctx: { secretKey: string; origin: string },
  body: PortalBody,
): Promise<ServiceResult<{ url: unknown }>> {
  const [row] = await db
    .select({ stripeCustomerId: tenantPlans.stripeCustomerId })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)

  if (!row?.stripeCustomerId) {
    return err('NOT_FOUND', 'No active subscription found')
  }

  const returnUrl = body.returnUrl ?? `${ctx.origin}/plans`

  const { ok: stripeOk, data } = await stripeApiRequest('POST', '/billing_portal/sessions', {
    customer: row.stripeCustomerId,
    return_url: returnUrl,
  }, ctx.secretKey)

  if (!stripeOk) {
    return err('INTERNAL_ERROR', 'Failed to create portal session', data)
  }

  return ok({ url: data['url'] })
}
