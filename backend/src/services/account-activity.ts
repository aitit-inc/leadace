import { and, count, gte, lt } from 'drizzle-orm'
import { accountDeletionSurveys, tenants } from '../db/schema'
import type { Db } from '../db/connection'
import { stripeApiRequest } from './stripe-api'

// Matches the */15 cron in wrangler.api.jsonc, so consecutive windows tile
// without gaps or overlaps.
const WINDOW_MS = 15 * 60_000

type AccountActivity = {
  signups: number
  totalAccounts: number
  deletionReasons: string[]
  paidCancellations: number
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

  // tenant_plans keeps no cancellation time; Stripe's event log is the record.
  const query = new URLSearchParams({
    type: 'customer.subscription.deleted',
    'created[gte]': String(Math.floor(from.getTime() / 1000)),
    'created[lt]': String(Math.floor(to.getTime() / 1000)),
    limit: '100',
  })
  const events = await stripeApiRequest('GET', `/events?${query}`, null, stripeKey)
  if (!events.ok) throw new Error(`account-activity: Stripe events list failed: ${JSON.stringify(events.data)}`)

  return {
    signups: signups?.n ?? 0,
    totalAccounts: total?.n ?? 0,
    deletionReasons: deletions.map((d) => d.reason),
    paidCancellations: (events.data['data'] as unknown[]).length,
  }
}

function formatAccountActivity(activity: AccountActivity, from: Date, to: Date): string {
  const time = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
  const date = from.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
  const deleted = activity.deletionReasons.length
  return [
    `🔔 LeadAce accounts — ${date} ${time(from)}–${time(to)} JST`,
    `👤 Signups +${activity.signups} (total ${activity.totalAccounts})`,
    `👋 Account deletions ${deleted}${deleted > 0 ? ` (${activity.deletionReasons.join(', ')})` : ''}`,
    `💳 Paid plan cancellations ${activity.paidCancellations}`,
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
  if (activity.signups === 0 && activity.deletionReasons.length === 0 && activity.paidCancellations === 0) return

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: formatAccountActivity(activity, windowStart, windowEnd) }),
  })
  if (!res.ok) {
    throw new Error(`account-activity webhook POST failed: ${res.status} ${await res.text()}`)
  }
}
