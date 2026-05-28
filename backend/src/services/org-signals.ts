import { sql } from 'drizzle-orm'
import { orgSignalsGlobal, type OrgSignals } from '../db/schema'
import type { Db } from '../db/connection'
import { callOpenAIResponses, OpenAIError, type OpenAIEnv } from './openai'

// How long a signal entry stays "fresh" before the daily picker considers
// it stale. 14d balances freshness for fast-moving funding / hiring news
// against per-tenant fetch volume on a Worker cron budget.
const REFRESH_INTERVAL_DAYS = 14

// Per-cron-run cap. The cron schedule below runs daily, so steady-state
// throughput is MAX_ORGS_PER_RUN orgs per day. Tune up once we have
// observability on per-org refresh latency / failure rate.
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

// org_signals_global is keyed on apex domain so cross-tenant overlap is
// shared. The picker selects domains with no cache entry yet, or whose
// cache is older than REFRESH_INTERVAL_DAYS. signals stays untouched on
// failure runs (we only bump signals_updated_at on success or hard-skip)
// so a successful but signal-empty extract still rotates out of the queue.
export async function pickStaleOrgDomains(db: Db, limit: number): Promise<string[]> {
  // sql.raw is fine for the integer `REFRESH_INTERVAL_DAYS` constant —
  // there's no user input on this path. INTERVAL '<n> days' takes a literal.
  const rows = await db.execute<{ domain: string }>(sql`
    SELECT DISTINCT o.domain
    FROM organizations o
    LEFT JOIN org_signals_global g ON g.domain = o.domain
    WHERE g.signals_updated_at IS NULL
       OR g.signals_updated_at < NOW() - INTERVAL '${sql.raw(String(REFRESH_INTERVAL_DAYS))} days'
    ORDER BY o.domain
    LIMIT ${limit}
  `)
  return rows.map((r) => r.domain)
}

// Best-effort: HTTP failures, parse failures, and LLM failures all log and
// return without writing the signals payload. The DB signals_updated_at is
// bumped even on partial / empty results so the picker doesn't keep
// selecting the same broken domain every run.
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

async function recordRefreshAttempt(
  db: Db,
  domain: string,
  signals: OrgSignals | null,
): Promise<void> {
  const now = new Date()
  await db
    .insert(orgSignalsGlobal)
    .values({
      domain,
      signals: signals ?? undefined,
      signalsUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: orgSignalsGlobal.domain,
      set: {
        // On a no-signal refresh we leave the old payload in place rather
        // than wiping a previously-successful extract — only the timestamp
        // is rolled forward to defer the next pick.
        ...(signals !== null ? { signals } : {}),
        signalsUpdatedAt: now,
      },
    })
}

function isEmptySignals(s: OrgSignals): boolean {
  return (
    !s.pressReleases?.length &&
    !s.funding &&
    !s.hiring &&
    !s.leadership?.length &&
    !s.highlights?.length
  )
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
    '- highlights: up to 5 short factual recent items, one sentence each.',
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
    return parseSignalsJson(result.outputText)
  } catch (e) {
    if (e instanceof OpenAIError) {
      console.warn(`[org-signals] OpenAI extraction failed for ${domain}: ${e.message}`)
    } else {
      console.warn(`[org-signals] unexpected error for ${domain}: ${(e as Error).message}`)
    }
    return null
  }
}

function parseSignalsJson(text: string): OrgSignals | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()
  try {
    const parsed: unknown = JSON.parse(cleaned)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    // We trust the shape — the model is given the type and rules. Downstream
    // readers degrade gracefully on missing / unexpected fields.
    return parsed as OrgSignals
  } catch {
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
  env: OpenAIEnv,
): Promise<DailyRefreshSummary> {
  const domains = await pickStaleOrgDomains(db, MAX_ORGS_PER_RUN)
  let updated = 0
  let empty = 0
  let failed = 0
  for (const d of domains) {
    const r = await refreshOrgSignal(db, env, d)
    if (r.updated) {
      updated++
    } else if (r.reason === 'no_signals') {
      empty++
    } else {
      failed++
    }
  }
  return { picked: domains.length, updated, empty, failed }
}
