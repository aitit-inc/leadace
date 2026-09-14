import { z } from 'zod'

// Prepaid credits cover usage past a paid plan's allowances, at the LP's prices.
export const USAGE_PRICE_CENTS = { contacted: 40, found: 60 } as const

// Any whole-dollar amount in this range buys credits; the packs are quick picks.
export const CREDIT_AMOUNT_CENTS = { min: 1000, max: 50_000 } as const
export const CREDIT_PACK_CENTS = [1000, 2500, 5000] as const
export const creditAmountSchema = z.number().int().min(CREDIT_AMOUNT_CENTS.min).max(CREDIT_AMOUNT_CENTS.max).multipleOf(100)

export const TOP_UP_THRESHOLD_CENTS = { min: 100, max: 10_000 } as const

export const autoTopUpSchema = z
  .object({
    enabled: z.boolean(),
    amountCents: creditAmountSchema.optional(),
    thresholdCents: z.number().int().min(TOP_UP_THRESHOLD_CENTS.min).max(TOP_UP_THRESHOLD_CENTS.max).optional(),
  })
  .strict()
export type AutoTopUpPatch = z.infer<typeof autoTopUpSchema>

export type AutoTopUp = {
  enabled: boolean
  amountCents: number
  thresholdCents: number
  // Stamped when the last off-session charge was declined (auto top-up was
  // switched off at the same time). Switching back on cannot verify the card,
  // so only a paid top-up clears it — or switching off again.
  failedAt: Date | null
}

// null = the plan cannot hold credits (free, unlimited, self-host).
export type CreditState = {
  balanceCents: number
  autoTopUp: AutoTopUp
} | null

// The balance never goes negative: a unit is allowed only when it is fully
// covered. Auto top-up refills the balance within seconds of a debit that
// leaves it under the threshold, so it does not enter this decision.
export function creditsCoverOverage(credits: CreditState, priceCents: number): boolean {
  return credits !== null && credits.balanceCents >= priceCents
}

// Discovery registers rows one at a time against a budget read once under the
// tenant lock: free slots first, then the running balance (null balance = the
// plan cannot hold credits). A null result stops the row — the caller skips it.
export type FoundRegistration = { charge: false } | { charge: true; balanceAfterCents: number } | null

export function nextFoundRegistration(freeSlotsLeft: number, balanceCents: number | null): FoundRegistration {
  if (freeSlotsLeft > 0) return { charge: false }
  if (balanceCents === null || balanceCents < USAGE_PRICE_CENTS.found) return null
  return { charge: true, balanceAfterCents: balanceCents - USAGE_PRICE_CENTS.found }
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`
}

// The tenant and amount a credit purchase or top-up stamps on its Stripe
// object; null on anything else (a renewal invoice, a plan Checkout).
export function creditMetadata(object: Record<string, unknown>): { tenantId: string; amountCents: number } | null {
  const metadata = object['metadata'] as Record<string, string> | null | undefined
  const tenantId = metadata?.['leadace_tenant_id']
  const amountCents = Number(metadata?.['leadace_credit_cents'])
  if (!tenantId || !Number.isInteger(amountCents) || amountCents <= 0) return null
  return { tenantId, amountCents }
}

// When Stripe collected the invoice (status_transitions.paid_at, unix
// seconds); the event's arrival time when the object does not carry it.
export function invoicePaidAt(invoice: Record<string, unknown>, now: Date): Date {
  const transitions = invoice['status_transitions'] as Record<string, unknown> | null | undefined
  const paidAt = Number(transitions?.['paid_at'])
  return Number.isFinite(paidAt) && paidAt > 0 ? new Date(paidAt * 1000) : now
}

// Stripe's error envelope: card_error = the customer's card declined.
export function isCardDecline(data: Record<string, unknown>): boolean {
  const error = data['error']
  return typeof error === 'object' && error !== null && 'type' in error && error.type === 'card_error'
}

// The slot a top-up claims before it creates the invoice, so two debits
// kicking at once cannot create two; replaced by the invoice id once created.
// A top-up completes in seconds, so a claim older than this was left by a
// run that died.
export const TOP_UP_CLAIM_PREFIX = 'claim:'
export const TOP_UP_CLAIM_TTL_MS = 10 * 60 * 1000

export function isStaleTopUpClaim(invoiceId: string, now: Date): boolean {
  if (!invoiceId.startsWith(TOP_UP_CLAIM_PREFIX)) return false
  const claimedAt = Date.parse(invoiceId.slice(TOP_UP_CLAIM_PREFIX.length))
  return Number.isNaN(claimedAt) || now.getTime() - claimedAt >= TOP_UP_CLAIM_TTL_MS
}
