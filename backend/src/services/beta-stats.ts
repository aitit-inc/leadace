import { sql } from 'drizzle-orm'
import { planEnum, type OrgSignals } from '../db/schema'
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
  inquiriesOpened: number
  replies: number
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
  opened: string | number
  replies: string | number
  bugs: string | number
  os_last_attempt: string | Date | null
  os_updated_today: string | number
}

export async function collectBetaStats(db: Db): Promise<BetaStats> {
  // One round-trip for all scalar counts. tenants stands in for signups: a
  // signed-in user triggers tenant auto-provisioning on their first API call,
  // so an auth.users row without a tenant is effectively unreachable.
  const [snap] = await db.execute<SnapshotRow>(sql`
    SELECT
      (SELECT count(*) FROM tenants WHERE created_at >= now() - INTERVAL '24 hours')::int AS users_day,
      (SELECT count(*) FROM tenants)::int AS users_total,
      (SELECT count(*) FROM outreach_logs WHERE status = 'sent' AND sent_at >= now() - INTERVAL '24 hours')::int AS sent,
      (SELECT count(DISTINCT tenant_id) FROM outreach_logs WHERE status = 'sent' AND sent_at >= now() - INTERVAL '24 hours')::int AS senders,
      (SELECT count(*) FROM inquiry_sessions WHERE opened_at >= now() - INTERVAL '24 hours')::int AS opened,
      (SELECT count(*) FROM responses WHERE received_at >= now() - INTERVAL '24 hours')::int AS replies,
      (SELECT count(*) FROM bug_reports WHERE created_at >= now() - INTERVAL '24 hours')::int AS bugs,
      (SELECT max(last_attempt_at) FROM org_signals_global) AS os_last_attempt,
      (SELECT count(*) FROM org_signals_global WHERE signals_updated_at >= CURRENT_DATE)::int AS os_updated_today
  `)
  if (!snap) throw new Error('beta-stats snapshot returned no row')

  const planRows = await db.execute<{ plan: Plan; n: string | number }>(sql`
    SELECT plan, count(*)::int AS n FROM tenant_plans GROUP BY plan
  `)
  const plans: Partial<Record<Plan, number>> = {}
  for (const r of planRows) plans[r.plan] = Number(r.n)

  const backlog = await countStaleOrgDomains(db)

  return {
    usersDay: Number(snap.users_day),
    usersTotal: Number(snap.users_total),
    sent: Number(snap.sent),
    senders: Number(snap.senders),
    inquiriesOpened: Number(snap.opened),
    replies: Number(snap.replies),
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
  const rows = await db.execute<SignalUpdate>(sql`
    SELECT domain, signals
    FROM org_signals_global
    WHERE signals_updated_at >= CURRENT_DATE
    ORDER BY domain
  `)
  return rows.map((r) => ({ domain: r.domain, signals: r.signals }))
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

  const lines = [
    `📊 LeadAce Daily (last 24h) — ${jstDate} JST`,
    `👤 Users +${stats.usersDay} (total ${stats.usersTotal})`,
    `📤 Sent ${stats.sent} (senders ${stats.senders})`,
    `💬 Inquiries ${stats.inquiriesOpened}  ·  📨 Replies ${stats.replies}  ·  🐛 Bugs ${stats.bugs}`,
    `💳 ${planLine}`,
    orgLine,
  ]
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
