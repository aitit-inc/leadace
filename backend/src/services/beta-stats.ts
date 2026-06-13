import { sql } from 'drizzle-orm'
import { planEnum } from '../db/schema'
import type { Db } from '../db/connection'
import { countStaleOrgDomains } from './org-signals'

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

type SnapshotRow = {
  users_day: number
  users_total: number
  sent: number
  senders: number
  opened: number
  replies: number
  bugs: number
  os_last_attempt: Date | null
  os_updated_today: number
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

  const planRows = await db.execute<{ plan: Plan; n: number }>(sql`
    SELECT plan, count(*)::int AS n FROM tenant_plans GROUP BY plan
  `)
  const plans: Partial<Record<Plan, number>> = {}
  for (const r of planRows) plans[r.plan] = r.n

  const backlog = await countStaleOrgDomains(db)

  return {
    usersDay: snap.users_day,
    usersTotal: snap.users_total,
    sent: snap.sent,
    senders: snap.senders,
    inquiriesOpened: snap.opened,
    replies: snap.replies,
    bugs: snap.bugs,
    plans,
    orgSignals: {
      lastAttemptAt: snap.os_last_attempt,
      updatedToday: snap.os_updated_today,
      backlog,
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

  const utcMidnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const os = stats.orgSignals
  const last = os.lastAttemptAt
  let orgLine: string
  if (os.backlog === 0) {
    orgLine = '🔄 org-signals ✅ backlog 0'
  } else if (last !== null && last >= utcMidnight) {
    orgLine = `🔄 org-signals ✅ 本日更新 ${os.updatedToday} / backlog ${os.backlog}（最終 ${hhmmUtc(last)} UTC）`
  } else {
    orgLine = `🔄 org-signals ⚠️ 本日未実行 / backlog ${os.backlog}（最終 ${last ? `${ymdHmUtc(last)} UTC` : 'なし'}）`
  }

  return [
    `📊 LeadAce Daily（直近24h）— ${jstDate} JST 時点`,
    `👤 ユーザー +${stats.usersDay}（累計 ${stats.usersTotal}）`,
    `📤 送信 ${stats.sent}（送信者 ${stats.senders}）`,
    `💬 開封 ${stats.inquiriesOpened}　📨 返信 ${stats.replies}　🐛 バグ ${stats.bugs}`,
    `💳 ${planLine}`,
    orgLine,
  ].join('\n')
}

const hhmmUtc = (d: Date) => d.toISOString().slice(11, 16)
const ymdHmUtc = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

export async function runDailyBetaStats(
  db: Db,
  env: { BETA_STATS_WEBHOOK_URL?: string },
): Promise<void> {
  const webhookUrl = env.BETA_STATS_WEBHOOK_URL
  if (!webhookUrl) return // cloud-only; no-op on self-host / local

  const text = formatBetaStats(await collectBetaStats(db), new Date())
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
