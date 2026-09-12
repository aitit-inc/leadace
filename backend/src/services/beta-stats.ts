import { sql, count } from 'drizzle-orm'
import { planEnum, tenantPlans } from '../db/schema'
import type { Db } from '../db/connection'
import { GROUNDING_FREE_QUERIES_PER_MONTH, groundingQuotaWarning, readGroundingQueries } from './grounding-usage'

type Plan = (typeof planEnum.enumValues)[number]

export type BetaStats = {
  usersDay: number
  usersTotal: number
  sent: number
  senders: number
  // Inquiry-landing sessions opened in the window, split by outcome. The four
  // outcome buckets are subsets of `total`; the remainder opened but took no
  // further action.
  inquiries: {
    total: number
    inquired: number
    lead: number
    signupClicked: number
    unsubscribed: number
  }
  // Responses received in the window. sentiment (positive/neutral/negative)
  // partitions `total`; meeting/bounce are cross-cutting response-type callouts.
  replies: {
    total: number
    positive: number
    neutral: number
    negative: number
    meeting: number
    bounce: number
  }
  bugs: number
  plans: Partial<Record<Plan, number>>
  groundingQueries: number
}

// Through the prod transaction pooler (Supavisor, prepare:false) postgres-js
// can't read column type OIDs, so db.execute returns every value as a string;
// a direct connection (local dev) returns parsed Date/number. Normalize at the
// boundary below so the rest of the code sees real Date/number either way.
type SnapshotRow = {
  users_day: string | number
  users_total: string | number
  sent: string | number
  senders: string | number
  inq_total: string | number
  inq_inquired: string | number
  inq_lead: string | number
  inq_signup: string | number
  inq_unsub: string | number
  rep_total: string | number
  rep_positive: string | number
  rep_neutral: string | number
  rep_negative: string | number
  rep_meeting: string | number
  rep_bounce: string | number
  bugs: string | number
}

export async function collectBetaStats(db: Db, now: Date): Promise<BetaStats> {
  // One round-trip for all counts. tenants stands in for signups: a signed-in
  // user triggers tenant auto-provisioning on their first API call, so an
  // auth.users row without a tenant is effectively unreachable. The inquiry /
  // reply breakdowns are FILTER aggregates inside a single per-table scan
  // (cross-joined as 1×1 rows), so adding resolution costs no extra scans on
  // the growing inquiry_sessions / responses tables.
  const [snap] = await db.execute<SnapshotRow>(sql`
    SELECT
      (SELECT count(*) FROM tenants WHERE created_at >= now() - INTERVAL '24 hours')::int AS users_day,
      (SELECT count(*) FROM tenants)::int AS users_total,
      (SELECT count(*) FROM outreach_logs WHERE status = 'sent' AND sent_at >= now() - INTERVAL '24 hours')::int AS sent,
      (SELECT count(DISTINCT tenant_id) FROM outreach_logs WHERE status = 'sent' AND sent_at >= now() - INTERVAL '24 hours')::int AS senders,
      iq.inq_total, iq.inq_inquired, iq.inq_lead, iq.inq_signup, iq.inq_unsub,
      rp.rep_total, rp.rep_positive, rp.rep_neutral, rp.rep_negative, rp.rep_meeting, rp.rep_bounce,
      (SELECT count(*) FROM bug_reports WHERE created_at >= now() - INTERVAL '24 hours')::int AS bugs
    FROM
      (SELECT
         count(*)::int AS inq_total,
         count(*) FILTER (WHERE outcome = 'inquired')::int AS inq_inquired,
         count(*) FILTER (WHERE outcome = 'lead')::int AS inq_lead,
         count(*) FILTER (WHERE outcome = 'signup_clicked')::int AS inq_signup,
         count(*) FILTER (WHERE outcome = 'unsubscribed')::int AS inq_unsub
       FROM inquiry_sessions
       WHERE opened_at >= now() - INTERVAL '24 hours') iq
      CROSS JOIN
      (SELECT
         count(*)::int AS rep_total,
         count(*) FILTER (WHERE sentiment = 'positive')::int AS rep_positive,
         count(*) FILTER (WHERE sentiment = 'neutral')::int AS rep_neutral,
         count(*) FILTER (WHERE sentiment = 'negative')::int AS rep_negative,
         count(*) FILTER (WHERE response_type = 'meeting_request')::int AS rep_meeting,
         count(*) FILTER (WHERE response_type = 'bounce')::int AS rep_bounce
       FROM responses
       WHERE received_at >= now() - INTERVAL '24 hours') rp
  `)
  if (!snap) throw new Error('beta-stats snapshot returned no row')

  const planRows = await db
    .select({ plan: tenantPlans.plan, n: count() })
    .from(tenantPlans)
    .groupBy(tenantPlans.plan)
  const plans: Partial<Record<Plan, number>> = {}
  for (const r of planRows) plans[r.plan] = r.n
  const groundingQueries = await readGroundingQueries(db, now)

  return {
    usersDay: Number(snap.users_day),
    usersTotal: Number(snap.users_total),
    sent: Number(snap.sent),
    senders: Number(snap.senders),
    inquiries: {
      total: Number(snap.inq_total),
      inquired: Number(snap.inq_inquired),
      lead: Number(snap.inq_lead),
      signupClicked: Number(snap.inq_signup),
      unsubscribed: Number(snap.inq_unsub),
    },
    replies: {
      total: Number(snap.rep_total),
      positive: Number(snap.rep_positive),
      neutral: Number(snap.rep_neutral),
      negative: Number(snap.rep_negative),
      meeting: Number(snap.rep_meeting),
      bounce: Number(snap.rep_bounce),
    },
    bugs: Number(snap.bugs),
    plans,
    groundingQueries,
  }
}

export function formatBetaStats(stats: BetaStats, now: Date): string {
  const jstDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })

  const planLine =
    planEnum.enumValues
      .filter((p) => (stats.plans[p] ?? 0) > 0)
      .map((p) => `${p} ${stats.plans[p]}`)
      .join(' / ') || '—'

  const iq = stats.inquiries
  const rep = stats.replies
  const lines = [
    `📊 LeadAce Daily (last 24h) — ${jstDate} JST`,
    `👤 Users +${stats.usersDay} (total ${stats.usersTotal})`,
    `📤 Sent ${stats.sent} (senders ${stats.senders})`,
    `💬 Inquiries ${iq.total}  ·  📨 Replies ${rep.total}  ·  🐛 Bugs ${stats.bugs}`,
  ]
  if (iq.total > 0) {
    lines.push(
      `   ↳ Inquiries: 🎯 ${iq.lead} lead · 🔗 ${iq.signupClicked} signup · ✍️ ${iq.inquired} chat · 🚫 ${iq.unsubscribed} unsub`,
    )
  }
  if (rep.total > 0) {
    lines.push(
      `   ↳ Replies: 👍 ${rep.positive} · 😐 ${rep.neutral} · 👎 ${rep.negative} · 🤝 ${rep.meeting} mtg · ⚠️ ${rep.bounce} bounce`,
    )
  }
  lines.push(`💳 ${planLine}`)
  lines.push(`🔎 Grounding ${stats.groundingQueries} / ${GROUNDING_FREE_QUERIES_PER_MONTH} queries this month${groundingQuotaWarning(stats.groundingQueries)}`)
  return lines.join('\n')
}

export async function runDailyBetaStats(
  db: Db,
  env: { BETA_STATS_WEBHOOK_URL?: string },
): Promise<void> {
  const webhookUrl = env.BETA_STATS_WEBHOOK_URL
  if (!webhookUrl) return // cloud-only; no-op on self-host / local

  const now = new Date()
  const stats = await collectBetaStats(db, now)
  const text = formatBetaStats(stats, now)

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    throw new Error(
      `beta-stats webhook POST failed: ${res.status} ${await res.text()}`,
    )
  }
}
