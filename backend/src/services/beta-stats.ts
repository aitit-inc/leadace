import { sql, count } from 'drizzle-orm'
import { planEnum, projectProspects, prospects, tenantPlans } from '../db/schema'
import { projectTargetExpr } from './prospects'
import type { Db } from '../db/connection'

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
  // Hosted discovery registers every candidate it judged: the last 24h beside
  // the 7 days before, so a pipeline change that starves supply shows (#875).
  found: { day: FoundRates; week: FoundRates }
}

// judged = candidates registered; fit = judged in the Target; reachable = fit
// with a contact on file.
export type FoundRates = { judged: number; fit: number; reachable: number }

const MIN_JUDGED = 30

export function foundRateDropped(day: FoundRates, week: FoundRates): boolean {
  if (day.judged < MIN_JUDGED || week.judged < MIN_JUDGED) return false
  const halved = (now: number, before: number) => now / day.judged < before / week.judged / 2
  return halved(day.fit, week.fit) || halved(day.reachable, week.reachable)
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
  found_day: string | number
  fit_day: string | number
  reachable_day: string | number
  found_week: string | number
  fit_week: string | number
  reachable_week: string | number
}

export async function collectBetaStats(db: Db): Promise<BetaStats> {
  // One round-trip for all counts. tenants stands in for signups: the
  // auth.users trigger creates a tenant with every account. The inquiry /
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
      (SELECT count(*) FROM bug_reports WHERE created_at >= now() - INTERVAL '24 hours')::int AS bugs,
      fd.found_day, fd.fit_day, fd.reachable_day, fd.found_week, fd.fit_week, fd.reachable_week
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
      CROSS JOIN
      (SELECT
         count(*) FILTER (WHERE day)::int AS found_day,
         count(*) FILTER (WHERE day AND fit)::int AS fit_day,
         count(*) FILTER (WHERE day AND reachable)::int AS reachable_day,
         count(*) FILTER (WHERE NOT day)::int AS found_week,
         count(*) FILTER (WHERE NOT day AND fit)::int AS fit_week,
         count(*) FILTER (WHERE NOT day AND reachable)::int AS reachable_week
       FROM (
         SELECT
           ${projectProspects.createdAt} >= now() - INTERVAL '24 hours' AS day,
           ${projectProspects.qualified} AS fit,
           ${projectTargetExpr} AS reachable
         FROM ${projectProspects} JOIN ${prospects} ON ${prospects.id} = ${projectProspects.prospectId}
         WHERE ${prospects.origin} = 'found' AND ${projectProspects.createdAt} >= now() - INTERVAL '8 days'
       ) j) fd
  `)
  if (!snap) throw new Error('beta-stats snapshot returned no row')

  const planRows = await db
    .select({ plan: tenantPlans.plan, n: count() })
    .from(tenantPlans)
    .groupBy(tenantPlans.plan)
  const plans: Partial<Record<Plan, number>> = {}
  for (const r of planRows) plans[r.plan] = r.n

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
    found: {
      day: { judged: Number(snap.found_day), fit: Number(snap.fit_day), reachable: Number(snap.reachable_day) },
      week: { judged: Number(snap.found_week), fit: Number(snap.fit_week), reachable: Number(snap.reachable_week) },
    },
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
  const { day, week } = stats.found
  const share = (n: number, of: number) => `${of === 0 ? 0 : Math.round((n / of) * 100)}%`
  lines.push(
    `🔎 Found ${day.judged} judged · fit ${share(day.fit, day.judged)} · with a contact ${share(day.reachable, day.judged)} (prior 7d ${share(week.fit, week.judged)} · ${share(week.reachable, week.judged)})${foundRateDropped(day, week) ? ' ⚠️ dropped by half' : ''}`,
  )
  lines.push(`💳 ${planLine}`)
  return lines.join('\n')
}

export async function runDailyBetaStats(
  db: Db,
  env: { BETA_STATS_WEBHOOK_URL?: string },
): Promise<void> {
  const webhookUrl = env.BETA_STATS_WEBHOOK_URL
  if (!webhookUrl) return // cloud-only; no-op on self-host / local

  const now = new Date()
  const stats = await collectBetaStats(db)
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
