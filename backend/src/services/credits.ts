import { z } from 'zod'
import { and, eq, isNull, lte, notExists, or, sql } from 'drizzle-orm'
import { creditLedger, outreachLogs, tenantPlans, type CreditEntryKind } from '../db/schema'
import { withDb, type Db } from '../db/connection'
import {
  creditAmountSchema,
  creditMetadata,
  formatCents,
  invoicePaidAt,
  isCardDecline,
  isStaleTopUpClaim,
  TOP_UP_CLAIM_PREFIX,
  USAGE_PRICE_CENTS,
  type AutoTopUp,
  type AutoTopUpPatch,
} from '../domain/credits'
import { parseEdition, type CloudEdition, type Edition } from '../domain/edition'
import type { TenantId } from '../domain/ids'
import { requireStripeCustomer } from './billing'
import { getTenantPlan, holdsCredits, livePreSend, sumCreditBalance } from './plan-limits'
import { ok, err, type ServiceResult } from './result'
import { stripeApiRequest } from './stripe-api'

export const creditCheckoutBodySchema = z.object({
  packCents: creditAmountSchema,
  successUrl: z.url().optional(),
  cancelUrl: z.url().optional(),
})
export type CreditCheckoutBody = z.infer<typeof creditCheckoutBodySchema>

// The one ledger write. Money in is positive, usage negative. Idempotent on
// (kind, reference): a redelivered webhook, a pay() racing its own
// invoice.paid event, or a prospect charged twice all land once.
async function creditLedgerEntry(
  db: Db,
  tenantId: string,
  kind: CreditEntryKind,
  amountCents: number,
  reference: string,
): Promise<void> {
  await db
    .insert(creditLedger)
    .values({ tenantId, kind, amountCents, reference })
    .onConflictDoNothing()
}

export function debitContacted(db: Db, tenantId: TenantId, prospectId: number): Promise<void> {
  return creditLedgerEntry(db, tenantId, 'usage_contacted', -USAGE_PRICE_CENTS.contacted, `prospect:${prospectId}`)
}

// A pre_send reservation that failed gives its debit back. Call it after the row
// has left pre_send: the debit is one ledger row per prospect, so it stays while
// another send to the prospect still owns it. The quota guard's lock makes that
// read wait for any reservation or refund of the tenant still in flight.
export async function refundContacted(db: Db, tenantId: TenantId, prospectId: number): Promise<void> {
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}))`)
  await db
    .delete(creditLedger)
    .where(and(
      eq(creditLedger.tenantId, tenantId),
      eq(creditLedger.kind, 'usage_contacted'),
      eq(creditLedger.reference, `prospect:${prospectId}`),
      notExists(
        db
          .select({ one: sql`1` })
          .from(outreachLogs)
          .where(and(
            eq(outreachLogs.tenantId, tenantId),
            eq(outreachLogs.prospectId, prospectId),
            or(eq(outreachLogs.status, 'sent'), and(livePreSend(), eq(outreachLogs.chargesCredits, true))),
          )),
      ),
    ))
}

export function debitFound(db: Db, tenantId: TenantId, prospectId: number): Promise<void> {
  return creditLedgerEntry(db, tenantId, 'usage_found', -USAGE_PRICE_CENTS.found, `prospect:${prospectId}`)
}

const NO_PAID_PLAN = err(
  'FORBIDDEN',
  'Credits require a paid plan',
  'Prepaid credits cover usage past a paid plan’s allowance. Upgrade on the plans page first.',
)

// See billing.ts createCheckoutSession for the role of `_cloud`.
export async function createCreditCheckoutSession(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  ctx: { secretKey: string; origin: string },
  body: CreditCheckoutBody,
): Promise<ServiceResult<{ url: unknown }>> {
  const tp = await getTenantPlan(db, tenantId, edition)
  if (!tp.autoTopUp) return NO_PAID_PLAN
  const customer = await requireStripeCustomer(db, tenantId)
  if (!customer.ok) return customer

  const successUrl = body.successUrl ?? `${ctx.origin}/plans?credits=success`
  const cancelUrl = body.cancelUrl ?? `${ctx.origin}/plans?credits=cancel`

  // The subscription's Customer already carries the billing address from the
  // plan Checkout; customer_update[address]=auto lets Stripe Tax refresh it.
  const { ok: stripeOk, data } = await stripeApiRequest('POST', '/checkout/sessions', {
    'mode': 'payment',
    'locale': 'auto',
    'customer': customer.value,
    'customer_update[address]': 'auto',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(body.packCents),
    'line_items[0][price_data][product_data][name]': `LeadAce credits (${formatCents(body.packCents)})`,
    'line_items[0][quantity]': '1',
    'automatic_tax[enabled]': 'true',
    'invoice_creation[enabled]': 'true',
    'metadata[leadace_tenant_id]': tenantId,
    'metadata[leadace_credit_cents]': String(body.packCents),
    'success_url': successUrl,
    'cancel_url': cancelUrl,
  }, ctx.secretKey)

  if (!stripeOk) return err('INTERNAL_ERROR', 'Failed to create checkout session', data)
  return ok({ url: data['url'] })
}

// Switching off voids the invoice in flight, if any.
export async function updateAutoTopUp(
  _cloud: CloudEdition,
  db: Db,
  tenantId: TenantId,
  edition: Edition,
  ctx: { secretKey: string },
  patch: AutoTopUpPatch,
): Promise<ServiceResult<AutoTopUp>> {
  const tp = await getTenantPlan(db, tenantId, edition)
  if (!tp.autoTopUp) return NO_PAID_PLAN
  if (patch.enabled) {
    const customer = await requireStripeCustomer(db, tenantId)
    if (!customer.ok) return customer
  }
  const [updated] = await db
    .update(tenantPlans)
    .set({
      autoTopUpEnabled: patch.enabled,
      ...(patch.amountCents !== undefined ? { autoTopUpAmountCents: patch.amountCents } : {}),
      ...(patch.thresholdCents !== undefined ? { autoTopUpThresholdCents: patch.thresholdCents } : {}),
      ...(patch.enabled ? {} : { autoTopUpFailedAt: null }),
      updatedAt: new Date(),
    })
    .where(eq(tenantPlans.tenantId, tenantId))
    .returning({
      enabled: tenantPlans.autoTopUpEnabled,
      amountCents: tenantPlans.autoTopUpAmountCents,
      thresholdCents: tenantPlans.autoTopUpThresholdCents,
      failedAt: tenantPlans.autoTopUpFailedAt,
    })
  if (!updated) return err('NOT_FOUND', 'No plan row for this tenant')
  if (!patch.enabled) await abandonPendingTopUp(db, tenantId, ctx.secretKey)
  return ok(updated)
}

async function clearPendingTopUp(db: Db, tenantId: string, invoiceId: string): Promise<void> {
  await db
    .update(tenantPlans)
    .set({ autoTopUpInvoiceId: null, updatedAt: new Date() })
    .where(and(eq(tenantPlans.tenantId, tenantId), eq(tenantPlans.autoTopUpInvoiceId, invoiceId)))
}

// A collected top-up proves the card works, whether or not the invoice
// still holds the slot (a void that failed can be collected later, and
// Stripe does not order its events). A decline stamped after the payment
// is newer evidence and stays.
async function clearDeclineStamp(db: Db, tenantId: string, paidAt: Date): Promise<void> {
  await db
    .update(tenantPlans)
    .set({ autoTopUpFailedAt: null, updatedAt: new Date() })
    .where(and(eq(tenantPlans.tenantId, tenantId), lte(tenantPlans.autoTopUpFailedAt, paidAt)))
}

// Scoped to the invoice in flight so a late payment_failed for an invoice
// already voided cannot switch off a re-enabled tenant or orphan its next one.
async function markTopUpFailed(db: Db, tenantId: string, invoiceId: string, detail: unknown): Promise<void> {
  console.error('auto top-up: charge declined; auto top-up switched off', { tenantId, invoiceId, detail })
  await db
    .update(tenantPlans)
    .set({ autoTopUpEnabled: false, autoTopUpFailedAt: new Date(), autoTopUpInvoiceId: null, updatedAt: new Date() })
    .where(and(eq(tenantPlans.tenantId, tenantId), eq(tenantPlans.autoTopUpInvoiceId, invoiceId)))
}

// Card declined = the customer's problem, so auto top-up switches off; any
// other error is ours or transient and the open invoice is retried by the
// next debit's kick.
async function payTopUpInvoice(
  db: Db,
  tenantId: string,
  invoiceId: string,
  amountCents: number,
  secretKey: string,
): Promise<void> {
  const paid = await stripeApiRequest('POST', `/invoices/${invoiceId}/pay`, { off_session: 'true' }, secretKey)
  if (paid.ok) {
    await creditLedgerEntry(db, tenantId, 'auto_top_up', amountCents, invoiceId)
    await clearPendingTopUp(db, tenantId, invoiceId)
    await clearDeclineStamp(db, tenantId, invoicePaidAt(paid.data, new Date()))
    console.log('auto top-up: paid', { tenantId, invoiceId, amountCents })
    return
  }
  if (isCardDecline(paid.data)) {
    await stripeApiRequest('POST', `/invoices/${invoiceId}/void`, null, secretKey)
    await markTopUpFailed(db, tenantId, invoiceId, paid.data)
    return
  }
  console.error('auto top-up: pay failed, will retry on the next debit', { tenantId, invoiceId, error: paid.data })
}

// One invoice per top-up, built before any item lands on it so a stray
// pending invoice item of the customer is never swept in.
async function createTopUpInvoice(
  tenantId: string,
  customerId: string,
  subscriptionId: string | null,
  amountCents: number,
  secretKey: string,
): Promise<string | null> {
  let paymentMethod: string | null = null
  if (subscriptionId) {
    const sub = await stripeApiRequest('GET', `/subscriptions/${subscriptionId}`, null, secretKey)
    if (sub.ok) paymentMethod = (sub.data['default_payment_method'] as string | null) ?? null
  }
  const invoice = await stripeApiRequest('POST', '/invoices', {
    'customer': customerId,
    'collection_method': 'charge_automatically',
    'auto_advance': 'false',
    'pending_invoice_items_behavior': 'exclude',
    'automatic_tax[enabled]': 'true',
    'description': 'LeadAce credits (auto top-up)',
    'metadata[leadace_tenant_id]': tenantId,
    'metadata[leadace_credit_cents]': String(amountCents),
    ...(paymentMethod ? { default_payment_method: paymentMethod } : {}),
  }, secretKey)
  if (!invoice.ok) {
    console.error('auto top-up: invoice create failed', { tenantId, error: invoice.data })
    return null
  }
  const invoiceId = invoice.data['id'] as string
  const item = await stripeApiRequest('POST', '/invoiceitems', {
    customer: customerId,
    invoice: invoiceId,
    amount: String(amountCents),
    currency: 'usd',
    description: `LeadAce credits (${formatCents(amountCents)})`,
  }, secretKey)
  if (!item.ok) {
    console.error('auto top-up: invoice item failed', { tenantId, invoiceId, error: item.data })
    await stripeApiRequest('DELETE', `/invoices/${invoiceId}`, null, secretKey)
    return null
  }
  const finalized = await stripeApiRequest('POST', `/invoices/${invoiceId}/finalize`, null, secretKey)
  if (!finalized.ok) {
    console.error('auto top-up: finalize failed', { tenantId, invoiceId, error: finalized.data })
    await stripeApiRequest('DELETE', `/invoices/${invoiceId}`, null, secretKey)
    return null
  }
  return invoiceId
}

// An invoice an earlier kick left behind, settled at the amount stamped on it
// (the setting may have changed since) and voided when the tenant no longer
// wants top-ups. A failed GET keeps the reference for the next kick.
async function resumePendingTopUp(
  db: Db,
  tenantId: string,
  invoiceId: string,
  stillWanted: boolean,
  secretKey: string,
): Promise<void> {
  const inv = await stripeApiRequest('GET', `/invoices/${invoiceId}`, null, secretKey)
  if (!inv.ok) {
    console.error('auto top-up: pending invoice lookup failed, will retry on the next debit', { tenantId, invoiceId, error: inv.data })
    return
  }
  const status = inv.data['status'] as string | undefined
  const topUp = creditMetadata(inv.data)
  if (status === 'open' && stillWanted && topUp) {
    await payTopUpInvoice(db, tenantId, invoiceId, topUp.amountCents, secretKey)
    return
  }
  if (status === 'open') await stripeApiRequest('POST', `/invoices/${invoiceId}/void`, null, secretKey)
  if (status === 'paid' && topUp) {
    await creditLedgerEntry(db, tenantId, 'auto_top_up', topUp.amountCents, invoiceId)
    await clearDeclineStamp(db, tenantId, invoicePaidAt(inv.data, new Date()))
  }
  await clearPendingTopUp(db, tenantId, invoiceId)
}

// Claims the slot before the Stripe calls so two debits kicking at once
// cannot raise two invoices; a claim left by a run that died expires.
async function claimTopUpSlot(db: Db, tenantId: string, now: Date): Promise<string | null> {
  const claim = `${TOP_UP_CLAIM_PREFIX}${now.toISOString()}`
  const [claimed] = await db
    .update(tenantPlans)
    .set({ autoTopUpInvoiceId: claim, updatedAt: now })
    .where(and(eq(tenantPlans.tenantId, tenantId), isNull(tenantPlans.autoTopUpInvoiceId)))
    .returning({ tenantId: tenantPlans.tenantId })
  return claimed ? claim : null
}

// One tenant, one pass, run right after a debit committed (raw connection,
// no RLS — every query filters by tenant_id): settle an invoice left by an
// earlier kick, then top up when the balance is under the threshold. A kick
// that fails is retried by the next debit.
async function runAutoTopUpFor(db: Db, tenantId: TenantId, secretKey: string): Promise<void> {
  const now = new Date()
  const [row] = await db
    .select({
      plan: tenantPlans.plan,
      stripeCustomerId: tenantPlans.stripeCustomerId,
      stripeSubscriptionId: tenantPlans.stripeSubscriptionId,
      enabled: tenantPlans.autoTopUpEnabled,
      amountCents: tenantPlans.autoTopUpAmountCents,
      thresholdCents: tenantPlans.autoTopUpThresholdCents,
      invoiceId: tenantPlans.autoTopUpInvoiceId,
    })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)
  if (!row) return
  const wanted = row.enabled && holdsCredits(row.plan) && row.stripeCustomerId !== null

  if (row.invoiceId && isStaleTopUpClaim(row.invoiceId, now)) {
    await clearPendingTopUp(db, tenantId, row.invoiceId)
  } else if (row.invoiceId?.startsWith(TOP_UP_CLAIM_PREFIX)) {
    return
  } else if (row.invoiceId) {
    await resumePendingTopUp(db, tenantId, row.invoiceId, wanted, secretKey)
    return
  }
  if (!wanted || row.stripeCustomerId === null) return
  if ((await sumCreditBalance(db, tenantId)) >= row.thresholdCents) return

  const claim = await claimTopUpSlot(db, tenantId, now)
  if (!claim) return
  const invoiceId = await createTopUpInvoice(tenantId, row.stripeCustomerId, row.stripeSubscriptionId, row.amountCents, secretKey)
  if (!invoiceId) {
    await clearPendingTopUp(db, tenantId, claim)
    return
  }
  await db
    .update(tenantPlans)
    .set({ autoTopUpInvoiceId: invoiceId, updatedAt: now })
    .where(and(eq(tenantPlans.tenantId, tenantId), eq(tenantPlans.autoTopUpInvoiceId, claim)))
  await payTopUpInvoice(db, tenantId, invoiceId, row.amountCents, secretKey)
}

export type AutoTopUpEnv = { DATABASE_URL: string; LEADACE_EDITION: string; STRIPE_SECRET_KEY?: string }

// The fire-and-forget entry: a request handler hands it to waitUntil after
// the response, a job step awaits it after the send / registration step.
// Never throws — a top-up failure must not fail the send it follows.
export async function kickAutoTopUp(env: AutoTopUpEnv, tenantId: TenantId): Promise<void> {
  const secretKey = env.STRIPE_SECRET_KEY
  if (parseEdition(env.LEADACE_EDITION) !== 'cloud' || !secretKey) return
  try {
    await withDb(env.DATABASE_URL, (db) => runAutoTopUpFor(db, tenantId, secretKey))
  } catch (e) {
    console.error('auto top-up: kick failed', { tenantId, error: e })
  }
}

// Voids the invoice in flight for a tenant who switched auto top-up off or
// whose subscription lapsed; a paid one is still credited.
export async function abandonPendingTopUp(db: Db, tenantId: string, secretKey: string): Promise<void> {
  const [row] = await db
    .select({ invoiceId: tenantPlans.autoTopUpInvoiceId })
    .from(tenantPlans)
    .where(eq(tenantPlans.tenantId, tenantId))
    .limit(1)
  if (!row?.invoiceId || row.invoiceId.startsWith(TOP_UP_CLAIM_PREFIX)) return
  await resumePendingTopUp(db, tenantId, row.invoiceId, false, secretKey)
}

// Webhook side of a top-up: invoice.paid credits (idempotent with the
// synchronous pay above), invoice.payment_failed switches auto top-up off —
// only for the invoice still in flight.
export async function settleTopUpPaidEvent(db: Db, invoice: Record<string, unknown>): Promise<boolean> {
  const topUp = creditMetadata(invoice)
  if (!topUp) return false
  const invoiceId = invoice['id'] as string
  await creditLedgerEntry(db, topUp.tenantId, 'auto_top_up', topUp.amountCents, invoiceId)
  await clearPendingTopUp(db, topUp.tenantId, invoiceId)
  await clearDeclineStamp(db, topUp.tenantId, invoicePaidAt(invoice, new Date()))
  return true
}

export async function settleTopUpFailedEvent(db: Db, invoice: Record<string, unknown>): Promise<boolean> {
  const topUp = creditMetadata(invoice)
  if (!topUp) return false
  // The decline reason lives on the PaymentIntent (last_payment_error), not
  // on the invoice; the synchronous pay() already logged it, so here the
  // intent id is enough to find it in Stripe.
  await markTopUpFailed(db, topUp.tenantId, invoice['id'] as string, { paymentIntent: invoice['payment_intent'] ?? null })
  return true
}

// Money in from a one-time Checkout (mode=payment). `payment_status` gates
// it: an async method completes the session before the money clears and
// then sends checkout.session.async_payment_succeeded, handled the same way.
export async function settleCreditPurchase(db: Db, session: Record<string, unknown>): Promise<void> {
  const sessionId = session['id'] as string
  const purchase = creditMetadata(session)
  if (!purchase) {
    console.error('credit purchase: session without LeadAce metadata', { sessionId })
    return
  }
  if (session['payment_status'] !== 'paid') {
    console.log('credit purchase: not paid yet', { sessionId, ...purchase, paymentStatus: session['payment_status'] })
    return
  }
  await creditLedgerEntry(db, purchase.tenantId, 'purchase', purchase.amountCents, sessionId)
  console.log('credit purchase: credited', { sessionId, ...purchase })
}
