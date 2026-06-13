import { sql, count, gte } from 'drizzle-orm'
import { planEnum, tenantPlans, orgSignalsGlobal, type OrgSignals } from '../db/schema'
import type { Db } from '../db/connection'
import { countStaleOrgDomains } from './org-signals'
import { callGeminiText } from './gemini'

const TREND_MODEL = 'gemini-3.1-flash-lite'

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
  orgSignals: {
    lastAttemptAt: Date | null
    updatedToday: number
    backlog: number
  }
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
  os_last_attempt: string | Date | null
  os_updated_today: string | number
}

export async function collectBetaStats(db: Db): Promise<BetaStats> {
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
      (SELECT count(*) FROM bug_reports WHERE created_at >= now() - INTERVAL '24 hours')::int AS bugs,
      (SELECT max(last_attempt_at) FROM org_signals_global) AS os_last_attempt,
      (SELECT count(*) FROM org_signals_global WHERE signals_updated_at >= CURRENT_DATE)::int AS os_updated_today
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

  const backlog = await countStaleOrgDomains(db)

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
    orgSignals: {
      lastAttemptAt: snap.os_last_attempt ? new Date(snap.os_last_attempt) : null,
      updatedToday: Number(snap.os_updated_today),
      backlog: Number(backlog),
    },
  }
}

// ----- org-signal trend summary -----

type SignalUpdate = { domain: string; signals: OrgSignals }

export async function fetchTodaySignalUpdates(db: Db): Promise<SignalUpdate[]> {
  const rows = await db
    .select({ domain: orgSignalsGlobal.domain, signals: orgSignalsGlobal.signals })
    .from(orgSignalsGlobal)
    .where(gte(orgSignalsGlobal.signalsUpdatedAt, sql`CURRENT_DATE`))
    .orderBy(orgSignalsGlobal.domain)
  return rows.flatMap((r) => (r.signals ? [{ domain: r.domain, signals: r.signals }] : []))
}

// One compact line per company capturing which signal categories were found,
// no URLs. Feeds the trend-summary prompt — not shown to users directly.
function condenseSignals(domain: string, s: OrgSignals): string {
  const parts: string[] = []
  if (s.pressReleases?.length) {
    parts.push(`press: ${s.pressReleases.slice(0, 3).map((p) => p.title).join('; ')}`)
  }
  if (s.funding && (s.funding.round || s.funding.amount)) {
    parts.push(`funding: ${[s.funding.round, s.funding.amount].filter(Boolean).join(' ')}`)
  }
  if (s.hiring && (s.hiring.departments?.length || s.hiring.sampleTitles?.length)) {
    const dept = s.hiring.departments?.slice(0, 4).join('/') ?? ''
    const titles = s.hiring.sampleTitles?.slice(0, 3).join(', ') ?? ''
    parts.push(`hiring: ${[dept, titles].filter(Boolean).join(' — ')}`)
  }
  if (s.leadership?.length) {
    const people = s.leadership
      .slice(0, 3)
      .map((l) => [l.name, l.role].filter(Boolean).join(' '))
      .join('; ')
    parts.push(`leadership: ${people}`)
  }
  if (s.highlights?.length) {
    parts.push(`notes: ${s.highlights.slice(0, 2).join(' ')}`)
  }
  return `${domain}: ${parts.join('; ') || '(no categorized fields)'}`
}

function trendPrompt(updates: SignalUpdate[]): string {
  const lines = updates.map((u) => condenseSignals(u.domain, u.signals)).join('\n')
  return [
    'You are writing one section of an internal sales-intelligence daily report.',
    `Below are ${updates.length} companies whose business signals were refreshed today, with the kind of update found for each.`,
    '',
    lines,
    '',
    'Write EXACTLY 3 short bullet points summarizing the OVERALL TRENDS across these',
    'updates: which categories dominated (hiring, funding, product launches, patents,',
    'events, earnings, leadership changes, …), notable patterns by stage/industry, and',
    'anything sales-relevant. Do NOT describe companies one by one. Output only the 3',
    'bullets, each on its own line starting with "• ".',
  ].join('\n')
}

// Best-effort: 3-bullet text on success, an "unavailable" marker on LLM
// failure, or null when there is nothing to summarize. Never throws — the
// digest must still post its KPIs.
export async function summarizeSignalTrends(
  env: { GEMINI_API_KEY: string },
  updates: SignalUpdate[],
): Promise<string | null> {
  if (updates.length === 0) return null
  try {
    return await callGeminiText({
      apiKey: env.GEMINI_API_KEY,
      model: TREND_MODEL,
      prompt: trendPrompt(updates),
      temperature: 0.3,
      maxOutputTokens: 512,
    })
  } catch (e) {
    console.error('[beta-stats] signal-trend summary failed:', e instanceof Error ? e.message : String(e))
    return '• (trend summary unavailable)'
  }
}

export function formatBetaStats(
  stats: BetaStats,
  trends: string | null,
  now: Date,
): string {
  const jstDate = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })

  const planLine =
    planEnum.enumValues
      .filter((p) => (stats.plans[p] ?? 0) > 0)
      .map((p) => `${p} ${stats.plans[p]}`)
      .join(' / ') || '—'

  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const os = stats.orgSignals
  const last = os.lastAttemptAt
  let orgLine: string
  if (os.backlog === 0) {
    orgLine = '🔄 org-signals ✅ backlog 0'
  } else if (last !== null && last >= utcMidnight) {
    orgLine = `🔄 org-signals ✅ ${os.updatedToday} updated today / backlog ${os.backlog} (last run ${hhmmUtc(last)} UTC)`
  } else {
    orgLine = `🔄 org-signals ⚠️ no run today / backlog ${os.backlog} (last attempt ${last ? `${ymdHmUtc(last)} UTC` : 'never'})`
  }

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
  lines.push(`💳 ${planLine}`, orgLine)
  if (trends !== null) lines.push(`🧠 Signal trends:\n${trends}`)
  return lines.join('\n')
}

const hhmmUtc = (d: Date) => d.toISOString().slice(11, 16)
const ymdHmUtc = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export async function runDailyBetaStats(
  db: Db,
  env: { BETA_STATS_WEBHOOK_URL?: string; GEMINI_API_KEY: string },
): Promise<void> {
  const webhookUrl = env.BETA_STATS_WEBHOOK_URL
  if (!webhookUrl) return // cloud-only; no-op on self-host / local

  const stats = await collectBetaStats(db)
  const trends = await summarizeSignalTrends(env, await fetchTodaySignalUpdates(db))
  const text = formatBetaStats(stats, trends, new Date())

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
