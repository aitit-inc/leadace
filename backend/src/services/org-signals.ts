import { sql } from 'drizzle-orm'
import { orgSignalsGlobal, type OrgSignals } from '../db/schema'
import type { Db } from '../db/connection'
import { callOpenAIResponses, OpenAIError, type OpenAIEnv } from './openai'
import { isEmptySignals, parseOrgSignalsText } from '../domain/org-signals'

// 7d keeps successful payloads well inside the 14-day freshness window
// listReachable's ordering consumes.
const REFRESH_INTERVAL_DAYS = 7

export const MAX_ORGS_PER_RUN = 20

// Per-org HTTP fetch budget. Workers cron triggers run with a CPU/wallclock
// allowance well above the standard request limit, but we still cap to keep
// a stuck site from starving the rest of the batch.
const HTML_FETCH_TIMEOUT_MS = 8000

// Truncate the homepage HTML before handing it to the LLM. 200 KB covers
// most marketing sites and stays within a reasonable token budget for
// gpt-5.4-mini.
const HTML_MAX_BYTES = 200_000

const SIGNAL_MODEL = 'gpt-5.4-mini'

export async function pickStaleOrgDomains(db: Db, limit: number): Promise<string[]> {
  // sql.raw is fine for the integer `REFRESH_INTERVAL_DAYS` constant —
  // there's no user input on this path. INTERVAL '<n> days' takes a literal.
  const rows = await db.execute<{ domain: string }>(sql`
    SELECT DISTINCT o.domain, g.last_attempt_at
    FROM organizations o
    LEFT JOIN org_signals_global g ON g.domain = o.domain
    WHERE g.domain IS NULL
       OR g.last_attempt_at < NOW() - INTERVAL '${sql.raw(String(REFRESH_INTERVAL_DAYS))} days'
    ORDER BY g.last_attempt_at ASC NULLS FIRST, o.domain
    LIMIT ${limit}
  `)
  return rows.map((r) => r.domain)
}

export type RefreshOutcome =
  | { updated: true }
  | { updated: false; reason: 'fetch_failed' | 'extract_failed' | 'no_signals' }

export async function refreshOrgSignal(
  db: Db,
  env: OpenAIEnv,
  domain: string,
): Promise<RefreshOutcome> {
  const html = await fetchOrgHomepage(domain)
  if (html === null) {
    await recordRefreshAttempt(db, domain, null)
    return { updated: false, reason: 'fetch_failed' }
  }

  const signals = await extractSignalsViaLLM(env, domain, html)
  if (!signals) {
    await recordRefreshAttempt(db, domain, null)
    return { updated: false, reason: 'extract_failed' }
  }

  if (isEmptySignals(signals)) {
    await recordRefreshAttempt(db, domain, null)
    return { updated: false, reason: 'no_signals' }
  }

  await recordRefreshAttempt(db, domain, signals)
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

// We deliberately do NOT spider /news, /press, /about etc. for v1.0; the
// homepage usually carries hero copy + recent funding / hiring banners,
// which is enough for a coarse signal extract. Site-specific deep crawls
// belong in a v1.1 enrichment worker with per-host adapters.
async function fetchOrgHomepage(domain: string): Promise<string | null> {
  const url = `https://${domain}/`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTML_FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'LeadAce-Signal-Bot/1.0 (+https://leadace.ai)',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      console.warn(`[org-signals] fetch ${url} returned ${res.status}`)
      return null
    }
    const text = await res.text()
    return text.slice(0, HTML_MAX_BYTES)
  } catch (e) {
    console.warn(`[org-signals] fetch failed for ${domain}: ${(e as Error).message}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function extractSignalsViaLLM(
  env: OpenAIEnv,
  domain: string,
  html: string,
): Promise<OrgSignals | null> {
  const instructions = [
    'You extract structured business signals about a company from raw HTML.',
    '',
    'Return STRICT JSON matching this TypeScript type:',
    '{',
    '  "pressReleases"?: { "title": string, "url"?: string, "publishedAt"?: string }[],',
    '  "funding"?: { "round"?: string, "amount"?: string, "investors"?: string[], "announcedAt"?: string },',
    '  "hiring"?: { "totalOpen"?: number, "departments"?: string[], "sampleTitles"?: string[], "sourceUrl"?: string },',
    '  "leadership"?: { "name": string, "role"?: string, "sourceUrl"?: string }[],',
    '  "highlights"?: string[]',
    '}',
    '',
    'Rules:',
    '- Output ONLY JSON. No prose, no markdown code fence.',
    '- Omit fields when no information is available — do NOT fabricate.',
    '- Dates (publishedAt / announcedAt) must be absolute ISO YYYY-MM-DD — never relative.',
    '- highlights: up to 5 short factual recent items, one sentence each. Use',
    '  absolute dates ("on 2026-05-01"), never relative ones ("last week") —',
    '  the text is shown days later, when relative dates have gone stale.',
    '- If the page contains no useful business signals, return {}.',
  ].join('\n')

  try {
    const result = await callOpenAIResponses({
      apiKey: env.OPENAI_API_KEY,
      model: SIGNAL_MODEL,
      instructions,
      input: [{ role: 'user', content: `Domain: ${domain}\n\nHTML (truncated):\n${html}` }],
      temperature: 0.1,
      maxOutputTokens: 800,
    })
    return parseOrgSignalsText(result.outputText)
  } catch (e) {
    if (e instanceof OpenAIError) {
      console.warn(`[org-signals] OpenAI extraction failed for ${domain}: ${e.message}`)
    } else {
      console.warn(`[org-signals] unexpected error for ${domain}: ${(e as Error).message}`)
    }
    return null
  }
}

export type DailyRefreshSummary = {
  picked: number
  updated: number
  empty: number
  failed: number
}

export async function runDailySignalRefresh(
  db: Db,
  // Wider than OpenAIEnv: keyless self-host installs are decided here.
  env: { OPENAI_API_KEY: string | undefined },
): Promise<DailyRefreshSummary> {
  const apiKey = env.OPENAI_API_KEY
  if (!apiKey) {
    console.log('[org-signals] no LLM API key configured — skipping signal refresh')
    return { picked: 0, updated: 0, empty: 0, failed: 0 }
  }
  const openaiEnv: OpenAIEnv = { OPENAI_API_KEY: apiKey }

  const domains = await pickStaleOrgDomains(db, MAX_ORGS_PER_RUN)
  let updated = 0
  let empty = 0
  let failed = 0
  for (const d of domains) {
    try {
      const r = await refreshOrgSignal(db, openaiEnv, d)
      if (r.updated) {
        updated++
      } else if (r.reason === 'no_signals') {
        empty++
      } else {
        failed++
      }
    } catch (e) {
      // Only the DB write can throw here (fetch/LLM failures are caught in
      // refreshOrgSignal). Record a payload-less attempt so a
      // deterministically-bad payload can't pin the domain at the picker head.
      failed++
      console.error(
        `[org-signals] refresh crashed for ${d}: ${e instanceof Error ? e.message : String(e)}`,
      )
      await recordRefreshAttempt(db, d, null)
    }
  }
  return { picked: domains.length, updated, empty, failed }
}
