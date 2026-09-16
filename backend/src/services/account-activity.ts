import { and, count, gte, lt } from 'drizzle-orm'
import { accountDeletionSurveys, planEnum, tenantPlans, tenants } from '../db/schema'
import type { Db } from '../db/connection'
import { stripeApiRequest } from './stripe-api'
import type { PaidPlanTier, PlanTier } from './plan-limits'
import { effectivePlanFromStatus, planFromSubscriptionItems, type StripeSubscriptionItems } from './stripe-webhook'

// Matches the */15 cron in wrangler.api.jsonc, so consecutive windows tile
// without gaps or overlaps.
const WINDOW_MS = 15 * 60_000

export type PlanMovement =
  | { kind: 'switch'; from: PlanTier; to: PlanTier }
  | { kind: 'cancelScheduled'; plan: PaidPlanTier }
  | { kind: 'cancelReverted'; plan: PaidPlanTier }
  | { kind: 'canceled'; plan: PaidPlanTier }

export type StripeSubscriptionEvent = {
  type: string
  data: { object: Record<string, unknown>; previous_attributes?: Record<string, unknown> }
}

function switched(from: PlanTier, to: PlanTier): PlanMovement | null {
  return from === to ? null : { kind: 'switch', from, to }
}

// A move is a change in the tier the tenant actually holds, read exactly as
// the webhook grants it (effectivePlanFromStatus) so the two can't disagree: a
// subscription that Checkout left incomplete is no acquisition, and the update
// that activates it is. The tier itself comes from the plan price, and an
// update that touched the item list echoes the whole previous list ("if an
// array attribute has any updated elements, this object contains the entire
// array") — that echo is the only record of the tier a tenant came from.
export function planMovementOfEvent(event: StripeSubscriptionEvent): PlanMovement | null {
  const subscription = event.data.object
  const plan = planFromSubscriptionItems(subscription['items'] as StripeSubscriptionItems)
  if (!plan) return null
  const status = subscription['status'] as string | undefined
  const held = effectivePlanFromStatus(status, plan)

  switch (event.type) {
    case 'customer.subscription.created':
      return switched('free', held)
    // An incomplete subscription expiring is deleted too, and it never held a
    // tier to lose.
    case 'customer.subscription.deleted':
      return status === 'incomplete_expired' ? null : { kind: 'canceled', plan }
    case 'customer.subscription.updated': {
      const previous = event.data.previous_attributes
      if (!previous) return null
      const heldBefore = effectivePlanFromStatus(
        (previous['status'] as string | undefined) ?? status,
        planFromSubscriptionItems(previous['items'] as StripeSubscriptionItems) ?? plan,
      )
      const moved = switched(heldBefore, held)
      if (moved) return moved
      if (previous['cancel_at_period_end'] === false && subscription['cancel_at_period_end'] === true) {
        return { kind: 'cancelScheduled', plan }
      }
      if (previous['cancel_at_period_end'] === true && subscription['cancel_at_period_end'] === false) {
        return { kind: 'cancelReverted', plan }
      }
      return null
    }
    default:
      return null
  }
}

type PlanMix = Record<PlanTier, number>

type AccountActivity = {
  signups: number
  totalAccounts: number
  deletionReasons: string[]
  planMoves: PlanMovement[]
  planMix: PlanMix
}

async function collectAccountActivity(db: Db, stripeKey: string, from: Date, to: Date): Promise<AccountActivity> {
  // Deleting an account deletes its tenant, so an account created and deleted
  // inside one window shows only as a deletion. Nothing else keeps signups.
  const [signups] = await db
    .select({ n: count() })
    .from(tenants)
    .where(and(gte(tenants.createdAt, from), lt(tenants.createdAt, to)))
  const [total] = await db.select({ n: count() }).from(tenants)
  const deletions = await db
    .select({ reason: accountDeletionSurveys.reason })
    .from(accountDeletionSurveys)
    .where(and(gte(accountDeletionSurveys.createdAt, from), lt(accountDeletionSurveys.createdAt, to)))

  // tenant_plans holds the tier a tenant is on now, not how it got there;
  // Stripe's event log is the record of the moves.
  const query = new URLSearchParams([
    ['created[gte]', String(Math.floor(from.getTime() / 1000))],
    ['created[lt]', String(Math.floor(to.getTime() / 1000))],
    ['limit', '100'],
    ['types[]', 'customer.subscription.created'],
    ['types[]', 'customer.subscription.updated'],
    ['types[]', 'customer.subscription.deleted'],
  ])
  const events = await stripeApiRequest('GET', `/events?${query}`, null, stripeKey)
  if (!events.ok) throw new Error(`account-activity: Stripe events list failed: ${JSON.stringify(events.data)}`)

  const totalAccounts = total?.n ?? 0
  return {
    signups: signups?.n ?? 0,
    totalAccounts,
    deletionReasons: deletions.map((d) => d.reason),
    // Stripe lists newest first; the summary reads in the order things happened.
    planMoves: (events.data['data'] as StripeSubscriptionEvent[])
      .toReversed()
      .map(planMovementOfEvent)
      .filter((move) => move !== null),
    planMix: await collectPlanMix(db, totalAccounts),
  }
}

async function collectPlanMix(db: Db, totalAccounts: number): Promise<PlanMix> {
  const rows = await db
    .select({ plan: tenantPlans.plan, n: count() })
    .from(tenantPlans)
    .groupBy(tenantPlans.plan)

  // A tenant gets its tenant_plans row at Checkout, so the ones without a row
  // are free too: only the other tiers can be counted from the table.
  const nonFree = rows.filter((row) => row.plan !== 'free')
  const mix: PlanMix = { free: 0, starter: 0, pro: 0, scale: 0, unlimited: 0 }
  for (const row of nonFree) mix[row.plan] = row.n
  mix.free = totalAccounts - nonFree.reduce((sum, row) => sum + row.n, 0)
  return mix
}

function movementLabel(movement: PlanMovement): string {
  switch (movement.kind) {
    case 'switch':
      return `${movement.from} → ${movement.to}`
    case 'cancelScheduled':
      return `${movement.plan} cancel scheduled`
    case 'cancelReverted':
      return `${movement.plan} cancel reverted`
    case 'canceled':
      return `${movement.plan} canceled`
  }
}

function formatPlanMoves(moves: PlanMovement[]): string {
  if (moves.length === 0) return 'none'
  const counts = new Map<string, number>()
  for (const move of moves) {
    const label = movementLabel(move)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts].map(([label, n]) => `${label} ${n}`).join(', ')
}

function formatAccountActivity(activity: AccountActivity, from: Date, to: Date): string {
  const time = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
  const date = from.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  const deleted = activity.deletionReasons.length
  return [
    `🔔 LeadAce accounts — ${date} ${time(from)}–${time(to)} JST`,
    `👤 Signups +${activity.signups} (total ${activity.totalAccounts})`,
    `👋 Account deletions ${deleted}${deleted > 0 ? ` (${activity.deletionReasons.join(', ')})` : ''}`,
    `💳 Plan moves ${formatPlanMoves(activity.planMoves)}`,
    `📊 Plans ${planEnum.enumValues.map((tier) => `${tier} ${activity.planMix[tier]}`).join(', ')}`,
  ].join('\n')
}

export async function runAccountActivityAlert(
  db: Db,
  env: { BETA_STATS_WEBHOOK_URL?: string; STRIPE_SECRET_KEY?: string },
  windowEnd: Date,
): Promise<void> {
  const webhookUrl = env.BETA_STATS_WEBHOOK_URL
  const stripeKey = env.STRIPE_SECRET_KEY
  if (!webhookUrl || !stripeKey) return // cloud-only; no-op on self-host / local

  const windowStart = new Date(windowEnd.getTime() - WINDOW_MS)
  const activity = await collectAccountActivity(db, stripeKey, windowStart, windowEnd)
  if (activity.signups === 0 && activity.deletionReasons.length === 0 && activity.planMoves.length === 0) return

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: formatAccountActivity(activity, windowStart, windowEnd) }),
  })
  if (!res.ok) {
    throw new Error(`account-activity webhook POST failed: ${res.status} ${await res.text()}`)
  }
}
