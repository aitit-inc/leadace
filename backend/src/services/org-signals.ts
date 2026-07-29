import { sql, and, or, eq, isNull, lt, min, countDistinct, inArray } from 'drizzle-orm'
import { Type, type Schema } from '@google/genai'
import {
  organizations,
  orgSignalsGlobal,
  projectProspects,
  prospects,
  REACHABLE_STATUSES,
  type OrgSignals,
} from '../db/schema'
import type { Db } from '../db/connection'
import { callGeminiUrlContext, GeminiError, type GeminiEnv } from './gemini'
import { HIGHLIGHT_MAX_AGE_DAYS, isEmptySignals, parseOrgSignalsText } from '../domain/org-signals'
import { isPublicWebUrl } from '../domain/url'
import { RESERVED_NAME_SQL_PATTERN } from '../domain/email-deliverability'
import {
  isSameSite,
  orderByEventPreference,
  parseRobotsSitemaps,
  parseSitemap,
  preferEventSitemap,
  selectSignalUrls,
  type ParsedSitemap,
  type SitemapEntry,
} from '../domain/sitemap'

// 7d keeps successful payloads well inside the 14-day freshness window
// listReachable's ordering consumes.
const REFRESH_INTERVAL_DAYS = 7

// Each domain issues at most 4 fetches (robots, MAX_SITEMAP_FETCHES sitemap
// bodies, the Gemini call), plus the odd redirect hop, which counts as its own
// subrequest — 150 domains stays well inside a run's subrequest budget.
const MAX_ORGS_PER_RUN = 150

// ~8s per domain, so a full run lands around 3-4 minutes — inside the cron
// wall-time.
const REFRESH_CONCURRENCY = 6

const FETCH_TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5
// Bounds regex work on hostile or merely enormous sitemaps.
const MAX_SITEMAP_BYTES = 512 * 1024
// Shared across candidates and their index children so a chain of sitemap
// indexes cannot multiply one domain's subrequest cost.
const MAX_SITEMAP_FETCHES = 2
const MAX_SIGNAL_URLS = 3

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

// Demo and test orgs are registered on purpose, so the rows stay; they are just
// never enrichable — a reserved name resolves for nobody.
const enrichableCondition = sql`${organizations.domain} !~ ${RESERVED_NAME_SQL_PATTERN}`

const pickerCondition = and(staleCondition, enrichableCondition)

type StaleOrg = { domain: string; name: string }

// Ordering only, and deliberately without listReachable's timing / channel /
// country gates — duplicating that predicate here would put the same spec in two
// places. 'contacted' is included because follow-up and recycle sends run on it,
// and those are the sends that most need a fresh signal.
const PICKER_STATUSES = [...REACHABLE_STATUSES, 'contacted'] as const

const hasContactableProspect = sql<boolean>`EXISTS (
  SELECT 1 FROM ${prospects}
  JOIN ${projectProspects} ON ${projectProspects.prospectId} = ${prospects.id}
  WHERE ${prospects.organizationId} = ${organizations.id}
    AND ${prospects.doNotContact} = false
    AND ${inArray(projectProspects.status, PICKER_STATUSES)}
)`

async function pickStaleOrgs(db: Db, limit: number): Promise<StaleOrg[]> {
  // MIN(name): tenants may register the same domain under different names.
  const rows = await db
    .select({
      domain: organizations.domain,
      name: min(organizations.name),
    })
    .from(organizations)
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(pickerCondition)
    .groupBy(organizations.domain, orgSignalsGlobal.lastAttemptAt)
    .orderBy(
      sql`bool_or(${hasContactableProspect}) DESC`,
      sql`${orgSignalsGlobal.lastAttemptAt} ASC NULLS FIRST`,
      organizations.domain,
    )
    .limit(limit)
  // name is NOT NULL and each group has >=1 row, so min() is never null here.
  return rows.map((r) => ({ domain: r.domain, name: r.name! }))
}

export async function countStaleOrgDomains(db: Db): Promise<number> {
  const [row] = await db
    .select({ count: countDistinct(organizations.domain) })
    .from(organizations)
    .leftJoin(orgSignalsGlobal, eq(orgSignalsGlobal.domain, organizations.domain))
    .where(pickerCondition)
  return row?.count ?? 0
}

type RefreshOutcome =
  | { updated: true }
  | { updated: false; reason: 'api_failed' | 'parse_failed' | 'not_retrieved' | 'no_signals' }

async function refreshOrgSignal(
  db: Db,
  env: GeminiEnv,
  org: StaleOrg,
): Promise<RefreshOutcome> {
  const extracted = await readSignalsViaUrlContext(env, org)

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

function signalReadPrompt(org: StaleOrg, urls: readonly string[], today: string): string {
  // The prompt is line-structured, so a newline in the stored name would forge
  // a rule of its own.
  const name = org.name.replace(/\s+/g, ' ').trim()
  return [
    `Read the pages listed below and report only concrete, dated events at ${name}.`,
    '',
    `Company: ${name} (website domain: ${org.domain})`,
    `Today's date: ${today}`,
    'Pages:',
    ...urls.map((u) => `- ${u}`),
    '',
    'Report funding rounds, press releases / product launches, hiring (open',
    'roles), and leadership changes.',
    '',
    'Rules:',
    `- ${name} must be the SUBJECT of every entry, not merely the publisher of`,
    '  the page. A blog, newsletter, customer story, or industry roundup on this',
    '  site reports events at other companies; those are that other company\'s',
    '  events. Omit them from every field, leadership and hiring included — a',
    '  person appointed at another company is not this company\'s leadership.',
    '- Use ONLY text from those pages. Never use prior knowledge, and never guess.',
    '- Skip anything the pages do not date. A description of what the company does',
    '  is not an event — omit it.',
    `- Only events dated within the last ${HIGHLIGHT_MAX_AGE_DAYS} days. Omit older ones.`,
    '- Site housekeeping is not a business event: ignore updates to terms of',
    '  service, privacy policies, cookie notices, and copyright years.',
    '- Every entry must include its source URL (url / sourceUrl fields).',
    '- Dates (publishedAt / announcedAt) must be absolute ISO YYYY-MM-DD — never relative.',
    '- highlights: up to 5 one-sentence items, each stating its absolute date',
    '  ("Raised Series B on 2026-05-20"). An undated highlight is dropped, and a',
    '  relative one ("last week") goes stale silently — the text is read days later.',
    '- Verify the pages are about THIS company, not a similarly named one.',
    '- If a page could not be read, ignore it. If none carry dated events, return {}.',
  ].join('\n')
}

// Following redirects inside fetch would check the first URL only, and the hop
// is where the host changes: without this loop a same-site sitemap can 302 us
// onto any host at all, which is the steering this module refuses everywhere
// else. Both guards are re-applied per hop, so a chain that leaves the site is
// dropped even though each individual URL is a legitimate public one.
async function fetchText(url: string, maxBytes: number, domain: string): Promise<string | null> {
  let target = url
  for (let hop = 0; ; hop++) {
    if (!isPublicWebUrl(target) || !isSameSite(target, domain)) return null
    try {
      const res = await fetch(target, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'manual',
        headers: { 'user-agent': SIGNAL_FETCH_USER_AGENT },
      })
      // An empty Location resolves back to the URL we just asked for, so
      // treating it as a redirect would refetch the same page MAX_REDIRECTS
      // times.
      const location = redirectTarget(res)
      if (location === null) return res.ok ? await readCapped(res, maxBytes) : null
      if (hop >= MAX_REDIRECTS) return null
      target = new URL(location, target).toString()
    } catch {
      return null
    }
  }
}

export function redirectTarget(res: Response): string | null {
  if (res.status < 300 || res.status >= 400) return null
  const location = res.headers.get('location')?.trim()
  return location === undefined || location === '' ? null : location
}

// The sitemap protocol allows 50 MB, and res.text() would hold all of it in the
// isolate at once — across the concurrent workers that is enough to lose the
// whole run, not just this domain.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader()
  if (reader === undefined) return ''
  const decoder = new TextDecoder()
  let out = ''
  // Counting decoded UTF-16 units would let a multi-byte body (every JP site)
  // through at up to 3x the cap it is named for.
  let bytes = 0
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      out += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel()
  }
  // A character split across the last chunk boundary sits inside the decoder
  // until this flush.
  return out + decoder.decode()
}

const SIGNAL_FETCH_USER_AGENT = 'LeadAceBot/1.0 (+https://leadace.ai)'

async function resolveSignalUrls(domain: string): Promise<string[]> {
  const robots = await fetchText(`https://${domain}/robots.txt`, 32 * 1024, domain)
  // An off-site declaration would point our weekly fetch wherever the (any
  // signup's) robots.txt says, and buys nothing back: selectSignalUrls keeps
  // only same-site entries, which a sitemap hosted elsewhere rarely lists. Over
  // 1,040 prod domains, 38 declare one and none lose coverage by our ignoring it.
  const declared =
    robots === null ? [] : parseRobotsSitemaps(robots).filter((u) => isSameSite(u, domain))
  // domain is stored apex (normalizeDomain strips www), but plenty of sites —
  // measured, 13 of 22 unreachable apexes, nearly all JP schools and
  // municipalities — answer only on www.
  const candidates = orderByEventPreference([
    ...new Set([
      ...declared,
      `https://${domain}/sitemap.xml`,
      `https://www.${domain}/sitemap.xml`,
    ]),
  ])

  let remaining = MAX_SITEMAP_FETCHES
  for (const candidate of candidates) {
    if (remaining <= 0) break
    remaining--
    const parsed = await fetchSitemap(candidate, domain)
    if (parsed === null) continue

    let entries: SitemapEntry[] = []
    if (parsed.kind === 'urlset') {
      entries = parsed.entries
    } else if (remaining > 0) {
      const child = preferEventSitemap(parsed.locs)
      if (child !== undefined) {
        remaining--
        const childParsed = await fetchSitemap(child, domain)
        entries = childParsed?.kind === 'urlset' ? childParsed.entries : []
      }
    }

    const urls = selectSignalUrls(entries, domain, MAX_SIGNAL_URLS)
    if (urls.length > 0) return urls
  }
  // Both roots: url_context reports each one's retrieval separately and ignores
  // the one that fails, so this costs us no subrequest of our own.
  return [`https://${domain}/`, `https://www.${domain}/`].filter(isPublicWebUrl)
}

async function fetchSitemap(url: string, domain: string): Promise<ParsedSitemap | null> {
  const body = await fetchText(url, MAX_SITEMAP_BYTES, domain)
  return body === null ? null : parseSitemap(body)
}

type ExtractResult =
  | { ok: true; signals: OrgSignals }
  | { ok: false; reason: 'api_failed' | 'parse_failed' | 'not_retrieved' }

async function readSignalsViaUrlContext(env: GeminiEnv, org: StaleOrg): Promise<ExtractResult> {
  const now = new Date()
  try {
    const urls = await resolveSignalUrls(org.domain)
    if (urls.length === 0) return { ok: false, reason: 'not_retrieved' }
    const read = await callGeminiUrlContext({
      apiKey: env.GEMINI_API_KEY,
      model: GEMINI_SIGNAL_MODEL,
      prompt: signalReadPrompt(org, urls, now.toISOString().slice(0, 10)),
      responseSchema: ORG_SIGNALS_RESPONSE_SCHEMA,
      temperature: 0.1,
      maxOutputTokens: 8192,
    })
    // No page was read, so anything in the answer came from the model itself.
    if (read.retrievedUrls.length === 0) {
      return { ok: false, reason: 'not_retrieved' }
    }
    const signals = parseOrgSignalsText(read.text, now)
    if (signals === null) {
      console.warn(`[org-signals] Gemini output failed to parse for ${org.domain}`)
      return { ok: false, reason: 'parse_failed' }
    }
    return { ok: true, signals }
  } catch (e) {
    if (e instanceof GeminiError) {
      console.warn(`[org-signals] Gemini read failed for ${org.domain}: ${e.message}`)
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
  notRetrieved: number
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
  let notRetrieved = 0
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
          } else if (r.reason === 'not_retrieved') {
            notRetrieved++
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
  return { picked: orgs.length, updated, empty, notRetrieved, failed, staleRemaining }
}
