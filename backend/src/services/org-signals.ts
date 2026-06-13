import { sql, or, eq, isNull, lt, min, countDistinct } from 'drizzle-orm'
import { Type, type Schema } from '@google/genai'
import { organizations, orgSignalsGlobal, type OrgSignals } from '../db/schema'
import type { Db } from '../db/connection'
import { callGeminiGrounded, GeminiError, type GeminiEnv } from './gemini'
import { isEmptySignals, parseOrgSignalsText } from '../domain/org-signals'

// 7d keeps successful payloads well inside the 14-day freshness window
// listReachable's ordering consumes.
const REFRESH_INTERVAL_DAYS = 7

const MAX_ORGS_PER_RUN = 200

// 5 workers keep a full 200-domain run around 2 minutes (~2.3s/call measured),
// well inside the 15-minute cron wall-time and the subrequest budget.
const REFRESH_CONCURRENCY = 5

const GEMINI_SIGNAL_MODEL = 'gemini-3.1-flash-lite'

// Stale = never attempted (LEFT JOIN miss → domain IS NULL) or last attempt
// older than the refresh interval. sql.raw is fine for the integer constant —
// no user input on this path; INTERVAL '<n> days' takes a literal.
const staleCondition = or(
  isNull(orgSignalsGlobal.domain),
  lt(
    orgSignalsGlobal.lastAttemptAt,
    sql`NOW() - INTERVAL '${sql.raw(String(REFRESH_INTERVAL_DAYS))} days'`,
  ),
)

type StaleOrg = { domain: string; name: string }

async function pickStaleOrgs(db: Db, limit: number): Promise<StaleOrg[]> {
  // MIN(name): tenants may register the same domain under different names.
  const rows = await db
    .select({ domain: organizations.domain, name: min(organizations.name) })
    .from(organizations)
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(staleCondition)
    .groupBy(organizations.domain, orgSignalsGlobal.lastAttemptAt)
    .orderBy(sql`${orgSignalsGlobal.lastAttemptAt} ASC NULLS FIRST`, organizations.domain)
    .limit(limit)
  // name is NOT NULL and each group has >=1 row, so min() is never null here.
  return rows.map((r) => ({ domain: r.domain, name: r.name! }))
}

export async function countStaleOrgDomains(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(organizations.domain) })
    .from(organizations)
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(staleCondition)
  return row?.count ?? 0
}

type RefreshOutcome =
  | { updated: true }
  | { updated: false; reason: 'api_failed' | 'parse_failed' | 'no_signals' }

async function refreshOrgSignal(
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

// Gemini response schema mirroring OrgSignals in db/schema.ts.
const ORG_SIGNALS_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pressReleases: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          url: { type: Type.STRING },
          publishedAt: { type: Type.STRING },
        },
        required: ['title'],
      },
    },
    funding: {
      type: Type.OBJECT,
      properties: {
        round: { type: Type.STRING },
        amount: { type: Type.STRING },
        investors: { type: Type.ARRAY, items: { type: Type.STRING } },
        announcedAt: { type: Type.STRING },
      },
    },
    hiring: {
      type: Type.OBJECT,
      properties: {
        totalOpen: { type: Type.INTEGER },
        departments: { type: Type.ARRAY, items: { type: Type.STRING } },
        sampleTitles: { type: Type.ARRAY, items: { type: Type.STRING } },
        sourceUrl: { type: Type.STRING },
      },
    },
    leadership: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          role: { type: Type.STRING },
          sourceUrl: { type: Type.STRING },
        },
        required: ['name'],
      },
    },
    highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
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

type DailyRefreshSummary = {
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
  const queue = [...orgs]
  const worker = async () => {
    for (let org = queue.shift(); org !== undefined; org = queue.shift()) {
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
  }
  await Promise.all(Array.from({ length: REFRESH_CONCURRENCY }, () => worker()))
  const staleRemaining = await countStaleOrgDomains(db)
  return { picked: orgs.length, updated, empty, failed, staleRemaining }
}
