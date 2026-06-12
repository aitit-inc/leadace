import { sql } from 'drizzle-orm'
import { orgSignalsGlobal, type OrgSignals } from '../db/schema'
import type { Db } from '../db/connection'
import { callGeminiGrounded, GeminiError, type GeminiEnv } from './gemini'
import { isEmptySignals, parseOrgSignalsText } from '../domain/org-signals'

// 7d keeps successful payloads well inside the 14-day freshness window
// listReachable's ordering consumes.
const REFRESH_INTERVAL_DAYS = 7

export const MAX_ORGS_PER_RUN = 20

const GEMINI_SIGNAL_MODEL = 'gemini-3.1-flash-lite'

// sql.raw is fine for the integer `REFRESH_INTERVAL_DAYS` constant — there's
// no user input on this path. INTERVAL '<n> days' takes a literal.
const staleCondition = sql`
  g.domain IS NULL
  OR g.last_attempt_at < NOW() - INTERVAL '${sql.raw(String(REFRESH_INTERVAL_DAYS))} days'
`

export type StaleOrg = { domain: string; name: string }

export async function pickStaleOrgs(db: Db, limit: number): Promise<StaleOrg[]> {
  // MIN(name): tenants may register the same domain under different names.
  const rows = await db.execute<StaleOrg>(sql`
    SELECT o.domain, MIN(o.name) AS name
    FROM organizations o
    LEFT JOIN org_signals_global g ON g.domain = o.domain
    WHERE ${staleCondition}
    GROUP BY o.domain, g.last_attempt_at
    ORDER BY g.last_attempt_at ASC NULLS FIRST, o.domain
    LIMIT ${limit}
  `)
  return rows.map((r) => ({ domain: r.domain, name: r.name }))
}

export async function countStaleOrgDomains(db: Db): Promise<number> {
  const rows = await db.execute<{ count: number }>(sql`
    SELECT COUNT(DISTINCT o.domain)::int AS count
    FROM organizations o
    LEFT JOIN org_signals_global g ON g.domain = o.domain
    WHERE ${staleCondition}
  `)
  return rows[0]?.count ?? 0
}

export type RefreshOutcome =
  | { updated: true }
  | { updated: false; reason: 'api_failed' | 'parse_failed' | 'no_signals' }

export async function refreshOrgSignal(
  db: Db,
  env: GeminiEnv,
  org: StaleOrg,
): Promise<RefreshOutcome> {
  const extracted = await searchSignalsViaGemini(env, org)

  if (!extracted.ok) {
    await recordRefreshAttempt(db, org.domain, null)
    return { updated: false, reason: extracted.reason }
  }

  if (isEmptySignals(extracted.signals)) {
    await recordRefreshAttempt(db, org.domain, null)
    return { updated: false, reason: 'no_signals' }
  }

  await recordRefreshAttempt(db, org.domain, extracted.signals)
  return { updated: true }
}

export function refreshWriteSet(
  signals: OrgSignals | null,
  now: Date,
): { lastAttemptAt: Date; signals?: OrgSignals; signalsUpdatedAt?: Date } {
  return signals === null
    ? { lastAttemptAt: now }
    : { lastAttemptAt: now, signals, signalsUpdatedAt: now }
}

async function recordRefreshAttempt(
  db: Db,
  domain: string,
  signals: OrgSignals | null,
): Promise<void> {
  const set = refreshWriteSet(signals, new Date())
  await db
    .insert(orgSignalsGlobal)
    .values({ domain, ...set })
    .onConflictDoUpdate({
      target: orgSignalsGlobal.domain,
      set,
    })
}

// Gemini response schema (OpenAPI subset) mirroring OrgSignals in db/schema.ts.
const ORG_SIGNALS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    pressReleases: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          url: { type: 'STRING' },
          publishedAt: { type: 'STRING' },
        },
        required: ['title'],
      },
    },
    funding: {
      type: 'OBJECT',
      properties: {
        round: { type: 'STRING' },
        amount: { type: 'STRING' },
        investors: { type: 'ARRAY', items: { type: 'STRING' } },
        announcedAt: { type: 'STRING' },
      },
    },
    hiring: {
      type: 'OBJECT',
      properties: {
        totalOpen: { type: 'INTEGER' },
        departments: { type: 'ARRAY', items: { type: 'STRING' } },
        sampleTitles: { type: 'ARRAY', items: { type: 'STRING' } },
        sourceUrl: { type: 'STRING' },
      },
    },
    leadership: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          role: { type: 'STRING' },
          sourceUrl: { type: 'STRING' },
        },
        required: ['name'],
      },
    },
    highlights: { type: 'ARRAY', items: { type: 'STRING' } },
  },
}

function groundedSignalPrompt(org: StaleOrg, today: string): string {
  return [
    'You research recent business events about a company using Google Search.',
    '',
    `Company: ${org.name} (website domain: ${org.domain})`,
    `Today's date: ${today}`,
    '',
    'Search for company events from the last 30 days: funding rounds, press',
    'releases / product launches, hiring (open roles), and leadership changes.',
    '',
    'Rules:',
    '- Only report events found via search. Omit fields with no information — do NOT fabricate.',
    "- Only include events dated within the last 30 days of Today's date; omit older ones.",
    '- Every entry must include its source URL (url / sourceUrl fields).',
    '- Dates (publishedAt / announcedAt) must be absolute ISO YYYY-MM-DD — never relative.',
    '- highlights: up to 5 short factual recent items, one sentence each. Use',
    '  absolute dates ("on 2026-05-01"), never relative ones ("last week") —',
    '  the text is shown days later, when relative dates have gone stale.',
    '- Verify results are about THIS company (matching domain), not a similarly named one.',
    '- If you find no events from the last 30 days, return {}.',
  ].join('\n')
}

type ExtractResult =
  | { ok: true; signals: OrgSignals }
  | { ok: false; reason: 'api_failed' | 'parse_failed' }

async function searchSignalsViaGemini(env: GeminiEnv, org: StaleOrg): Promise<ExtractResult> {
  try {
    const outputText = await callGeminiGrounded({
      apiKey: env.GEMINI_API_KEY,
      model: GEMINI_SIGNAL_MODEL,
      prompt: groundedSignalPrompt(org, new Date().toISOString().slice(0, 10)),
      responseSchema: ORG_SIGNALS_RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 8192,
    })
    const signals = parseOrgSignalsText(outputText)
    if (signals === null) {
      console.warn(`[org-signals] Gemini output failed to parse for ${org.domain}`)
      return { ok: false, reason: 'parse_failed' }
    }
    return { ok: true, signals }
  } catch (e) {
    if (e instanceof GeminiError) {
      console.warn(`[org-signals] Gemini search failed for ${org.domain}: ${e.message}`)
    } else {
      console.warn(`[org-signals] unexpected error for ${org.domain}: ${(e as Error).message}`)
    }
    return { ok: false, reason: 'api_failed' }
  }
}

export type DailyRefreshSummary = {
  picked: number
  updated: number
  empty: number
  failed: number
  staleRemaining: number
}

export async function runDailySignalRefresh(
  db: Db,
  env: { GEMINI_API_KEY?: string },
): Promise<DailyRefreshSummary> {
  const apiKey = env.GEMINI_API_KEY
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured')
  }
  const geminiEnv: GeminiEnv = { GEMINI_API_KEY: apiKey }

  const orgs = await pickStaleOrgs(db, MAX_ORGS_PER_RUN)
  let updated = 0
  let empty = 0
  let failed = 0
  for (const org of orgs) {
    const startedAt = Date.now()
    let outcome: string
    try {
      const r = await refreshOrgSignal(db, geminiEnv, org)
      if (r.updated) {
        updated++
        outcome = 'updated'
      } else {
        outcome = r.reason
        if (r.reason === 'no_signals') {
          empty++
        } else {
          failed++
        }
      }
    } catch (e) {
      // Only the DB write can throw here (API/parse failures are caught in
      // refreshOrgSignal). Record a payload-less attempt so a
      // deterministically-bad payload can't pin the domain at the picker head.
      failed++
      outcome = 'crashed'
      console.error(
        `[org-signals] refresh crashed for ${org.domain}: ${e instanceof Error ? e.message : String(e)}`,
      )
      await recordRefreshAttempt(db, org.domain, null)
    }
    console.log(
      `[org-signals] refresh domain=${org.domain} outcome=${outcome} ms=${Date.now() - startedAt}`,
    )
  }
  const staleRemaining = await countStaleOrgDomains(db)
  return { picked: orgs.length, updated, empty, failed, staleRemaining }
}
