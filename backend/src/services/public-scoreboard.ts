import { z } from 'zod'
import { and, desc, eq, sql } from 'drizzle-orm'
import { projectDocuments, projectSettings, projects } from '../db/schema'
import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { ProjectId } from '../domain/ids'
import { replyRate } from '../domain/dashboard'
import { ok, err, type ServiceResult } from './result'
import { startOfTodayUtc } from './plan-limits'

export const liveQuerySchema = z.object({
  // Campaign tag carried by share links (?ref=hn1). Slug-only so the funnel
  // log never carries free text.
  ref: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/).optional(),
  embed: z.literal('1').optional(),
})
export type LiveQuery = z.infer<typeof liveQuerySchema>

export const PUBLIC_JOURNAL_SLUG = 'public_journal'
export const LIVE_TREND_DAYS = 7
export const LIVE_RECENT_DAYS = 30
const CACHE_TTL_MS = 5 * 60 * 1000

export type LiveDay = { date: string; sent: number; replies: number }

// Email-channel numbers only, matching the page's "emails sent" framing —
// form / DM touches are out of scope for the public scoreboard.
export type LiveScoreboard = {
  projectName: string
  // UTC date of the first send; null before the first one.
  activeSince: string | null
  daysActive: number
  sent: { today: number; total: number }
  // Human replies (bounce / auto_reply excluded), one per sent email.
  replies: { total: number; positive: number }
  // Percent of sent emails that got a human reply, one decimal.
  replyRate: number
  recent: { days: number; sent: number; replyRate: number }
  // Percent of bounce-eligible (threadable email) sends that bounced, one decimal.
  bounceRate: number
  // Platform signups (tenants). Cloud only — meaningless on a self-hosted install.
  signups: { today: number; total: number } | null
  // Oldest first, LIVE_TREND_DAYS entries ending today (UTC). `replies` buckets
  // each outreach log once, on the day of its FIRST human reply.
  daily: LiveDay[]
  journal: { content: string; date: string } | null
  computedAt: string
}

// Through the prod transaction pooler (prepare:false) postgres-js can't read
// column type OIDs, so raw db.execute returns numbers as strings.
type TotalsRow = {
  sent_total: string | number
  sent_today: string | number
  replied: string | number
  positive: string | number
  sent_recent: string | number
  replied_recent: string | number
  bounce_eligible: string | number
  bounced: string | number
  first_sent_day: string | null
}
type DayRow = { day: string; count: string | number }
type SignupRow = { today: string | number; total: string | number }

const num = (v: string | number): number => Number(v)

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Fills every UTC day in the window so the bars never skip a quiet day.
export function buildDaily(
  sent: DayRow[],
  replies: DayRow[],
  now: Date,
  days: number = LIVE_TREND_DAYS,
): LiveDay[] {
  const sentBy = new Map(sent.map((r) => [r.day, num(r.count)]))
  const repliesBy = new Map(replies.map((r) => [r.day, num(r.count)]))
  const start = startOfTodayUtc(now).getTime()
  const out: LiveDay[] = []
  for (let i = days - 1; i >= 0; i--) {
    const date = utcDateString(new Date(start - i * 86_400_000))
    out.push({ date, sent: sentBy.get(date) ?? 0, replies: repliesBy.get(date) ?? 0 })
  }
  return out
}

export function daysActiveSince(firstSentDay: string | null, now: Date): number {
  if (!firstSentDay) return 0
  const first = Date.parse(`${firstSentDay}T00:00:00Z`)
  if (Number.isNaN(first)) return 0
  return Math.max(0, Math.floor((startOfTodayUtc(now).getTime() - first) / 86_400_000)) + 1
}

type ScoreboardProject = { name: string; enabled: boolean }

async function loadScoreboardProject(
  db: Db,
  projectId: ProjectId,
): Promise<ScoreboardProject | null> {
  const [row] = await db
    .select({ name: projects.name, enabled: projectSettings.publicScoreboardEnabled })
    .from(projects)
    .innerJoin(projectSettings, eq(projectSettings.projectId, projects.id))
    .where(eq(projects.id, projectId))
    .limit(1)
  return row ?? null
}

async function computeScoreboard(
  db: Db,
  projectId: ProjectId,
  projectName: string,
  edition: Edition,
  now: Date,
): Promise<ServiceResult<LiveScoreboard>> {
  const todayStartIso = startOfTodayUtc(now).toISOString()
  const sinceIso = (days: number) =>
    new Date(startOfTodayUtc(now).getTime() - (days - 1) * 86_400_000).toISOString()
  const trendSinceIso = sinceIso(LIVE_TREND_DAYS)
  const recentSinceIso = sinceIso(LIVE_RECENT_DAYS)

  const raw = async <T extends Record<string, unknown>>(q: ReturnType<typeof sql>): Promise<T[]> =>
    Array.from(await db.execute<T>(q)) as T[]

  const [[totals], sentByDay, repliesByDay, signupRows, [journalRow]] = await Promise.all([
    // Per sent email: a reply / bounce counts once no matter how many
    // messages the thread carries.
    raw<TotalsRow>(sql`
      WITH s AS (
        SELECT id, sent_at, (message_id IS NOT NULL) AS bounce_eligible
        FROM outreach_logs
        WHERE project_id = ${projectId} AND status = 'sent' AND channel = 'email'
      ),
      b AS (
        SELECT DISTINCT r.outreach_log_id
        FROM responses r JOIN s ON s.id = r.outreach_log_id
        WHERE r.response_type = 'bounce'
      ),
      h AS (
        SELECT r.outreach_log_id,
               bool_or(r.sentiment = 'positive' OR r.response_type = 'meeting_request') AS positive
        FROM responses r JOIN s ON s.id = r.outreach_log_id
        WHERE r.response_type NOT IN ('bounce', 'auto_reply')
        GROUP BY 1
      )
      SELECT
        COUNT(*)::int AS sent_total,
        COUNT(*) FILTER (WHERE s.sent_at >= ${todayStartIso}::timestamptz)::int AS sent_today,
        COUNT(h.outreach_log_id)::int AS replied,
        COUNT(*) FILTER (WHERE h.positive)::int AS positive,
        COUNT(*) FILTER (WHERE s.sent_at >= ${recentSinceIso}::timestamptz)::int AS sent_recent,
        COUNT(h.outreach_log_id) FILTER (WHERE s.sent_at >= ${recentSinceIso}::timestamptz)::int AS replied_recent,
        COUNT(*) FILTER (WHERE s.bounce_eligible)::int AS bounce_eligible,
        COUNT(b.outreach_log_id) FILTER (WHERE s.bounce_eligible)::int AS bounced,
        (MIN(s.sent_at) AT TIME ZONE 'UTC')::date::text AS first_sent_day
      FROM s
      LEFT JOIN b ON b.outreach_log_id = s.id
      LEFT JOIN h ON h.outreach_log_id = s.id`),
    raw<DayRow>(sql`
      SELECT (sent_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
      FROM outreach_logs
      WHERE project_id = ${projectId} AND status = 'sent' AND channel = 'email'
        AND sent_at >= ${trendSinceIso}::timestamptz
      GROUP BY day`),
    // Each outreach log lands on ONE bar: the day of its first human reply
    // (a later follow-up on the same thread is not a second reply).
    raw<DayRow>(sql`
      SELECT (t.first_at AT TIME ZONE 'UTC')::date::text AS day, COUNT(*)::int AS count
      FROM (
        SELECT r.outreach_log_id, MIN(r.received_at) AS first_at
        FROM responses r JOIN outreach_logs ol ON ol.id = r.outreach_log_id
        WHERE ol.project_id = ${projectId} AND ol.status = 'sent' AND ol.channel = 'email'
          AND r.response_type NOT IN ('bounce', 'auto_reply')
        GROUP BY r.outreach_log_id
      ) t
      WHERE t.first_at >= ${trendSinceIso}::timestamptz
      GROUP BY day`),
    edition === 'cloud'
      ? raw<SignupRow>(sql`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE created_at >= ${todayStartIso}::timestamptz)::int AS today
          FROM tenants`)
      : Promise.resolve([] as SignupRow[]),
    db
      .select({ content: projectDocuments.content, createdAt: projectDocuments.createdAt })
      .from(projectDocuments)
      .where(
        and(eq(projectDocuments.projectId, projectId), eq(projectDocuments.slug, PUBLIC_JOURNAL_SLUG)),
      )
      .orderBy(desc(projectDocuments.createdAt))
      .limit(1),
  ])

  if (!totals) return err('INTERNAL_ERROR', 'Scoreboard totals query returned no row')
  const sentTotal = num(totals.sent_total)
  const sentRecent = num(totals.sent_recent)
  const signups = signupRows[0]
  return ok({
    projectName,
    activeSince: totals.first_sent_day,
    daysActive: daysActiveSince(totals.first_sent_day, now),
    sent: { today: num(totals.sent_today), total: sentTotal },
    replies: { total: num(totals.replied), positive: num(totals.positive) },
    replyRate: replyRate(num(totals.replied), sentTotal),
    recent: {
      days: LIVE_RECENT_DAYS,
      sent: sentRecent,
      replyRate: replyRate(num(totals.replied_recent), sentRecent),
    },
    bounceRate: replyRate(num(totals.bounced), num(totals.bounce_eligible)),
    signups: signups ? { today: num(signups.today), total: num(signups.total) } : null,
    daily: buildDaily(sentByDay, repliesByDay, now),
    journal: journalRow
      ? { content: journalRow.content, date: new Date(journalRow.createdAt).toISOString() }
      : null,
    computedAt: now.toISOString(),
  })
}

export async function getPublicScoreboard(
  db: Db,
  projectId: ProjectId,
  edition: Edition,
  now: Date = new Date(),
): Promise<ServiceResult<LiveScoreboard>> {
  const project = await loadScoreboardProject(db, projectId)
  if (!project || !project.enabled) return err('NOT_FOUND', 'Scoreboard not available')
  return computeScoreboard(db, projectId, project.name, edition, now)
}

// Per isolate, 5 min, opt-in state included: a warm hit on this public page
// costs no DB round trip, and switching the scoreboard on or off shows within
// one TTL.
const cache = new Map<string, { result: ServiceResult<LiveScoreboard>; expiresAt: number }>()

export async function getCachedPublicScoreboard(
  db: Db,
  projectId: ProjectId,
  edition: Edition,
  now: Date = new Date(),
): Promise<ServiceResult<LiveScoreboard>> {
  const hit = cache.get(projectId)
  if (hit && hit.expiresAt > now.getTime()) return hit.result
  const fresh = await getPublicScoreboard(db, projectId, edition, now)
  if (fresh.ok || fresh.code === 'NOT_FOUND') {
    cache.set(projectId, { result: fresh, expiresAt: now.getTime() + CACHE_TTL_MS })
  }
  return fresh
}
