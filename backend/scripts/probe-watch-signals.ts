/**
 * D1 (watch tower) preflight — answers the two questions that gate building
 * T1/T2, in a single crawl. Touches no DB; reads the V2 baseline file only.
 *
 * Q1  How noisy is homepage hash-diffing?  Two homepage fetches minutes apart
 *     put a floor under the false-positive rate: nothing real ships in that
 *     window, so every differing hash is noise. The same hash also diffs
 *     against the V2 baseline for the total change rate over the window since
 *     it was taken, and sitemap lastmod within that window separates "the page
 *     really moved" from churn on the domains that carry a marker.
 *
 * Q1b Can the server answer instead?  Conditional GET (ETag / If-Modified-Since)
 *     is HTTP's own change signal and predates every tool that reimplements it.
 *     Measures who offers a validator, who honours it with 304, and — the part
 *     that matters — whether a 304 ever arrives while the text has moved.
 *
 * Q2  Does the sitemap say *what* changed?  Counts same-site entries under an
 *     event path (/news/, /press/, /recruit/ …) that carry lastmod, so T1 could
 *     hand T2 a URL rather than just "something moved on this site".
 *
 * The document hash reproduces the V2 baseline's: sha256 of the decoded body
 * with whitespace runs collapsed to one space and trimmed, first 16 hex chars.
 * The script that wrote that baseline was never committed and had to be
 * reverse-engineered from its output, which is why this one is in the repo.
 *
 * Re-running against its own output (--baseline=<previous --out>) turns the
 * one-shot into a real time diff, and the window under test scales with it:
 * the visible-text hash and the conditional-GET check both need days, not
 * minutes, and neither has a baseline older than the 2026-07-29 run.
 *
 * Usage:
 *   npx tsx scripts/probe-watch-signals.ts
 *   npx tsx scripts/probe-watch-signals.ts --limit=40 --concurrency=8
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import {
  isEventPath,
  isSameSite,
  orderByEventPreference,
  parseRobotsSitemaps,
  parseSitemap,
  preferEventSitemap,
  type SitemapEntry,
} from '../src/domain/sitemap'

const FETCH_TIMEOUT_MS = 15000
const MAX_SITEMAP_FETCHES = 2
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_SITEMAP_BYTES = 8 * 1024 * 1024
const RECENT_EVENT_URLS = 5
const USER_AGENT = 'LeadAceBot/1.0 (+https://leadace.ai)'
const DAY_MS = 86_400_000

/**
 * Two shapes are accepted: the V2 baseline (document hash only) and this
 * script's own output, so a re-run diffs both hashes without new code.
 */
const v2BaselineSchema = z.object({
  measuredAt: z.iso.datetime(),
  results: z.array(z.object({ domain: z.string().min(1), homeHash: z.string().nullable() })).min(1),
})
const priorRunSchema = z.object({
  measuredAt: z.iso.datetime(),
  results: z
    .array(
      z.object({
        domain: z.string().min(1),
        passA: z.object({
          hash: z.string().nullable(),
          textHash: z.string().nullable(),
          viaWww: z.boolean(),
          validators: z.object({
            etag: z.string().nullable(),
            lastModified: z.string().nullable(),
          }),
        }),
      }),
    )
    .min(1),
})

type BaselineRow = {
  domain: string
  hash: string | null
  textHash: string | null
  validators: Validators | null
}

function readBaseline(raw: unknown): { measuredAt: string; rows: BaselineRow[] } {
  const v2 = v2BaselineSchema.safeParse(raw)
  if (v2.success) {
    return {
      measuredAt: v2.data.measuredAt,
      rows: v2.data.results.map((r) => ({
        domain: r.domain,
        hash: r.homeHash,
        textHash: null,
        validators: null,
      })),
    }
  }
  const prior = priorRunSchema.parse(raw)
  return {
    measuredAt: prior.measuredAt,
    // A www answer hashed a different host than the apex the next run reads.
    rows: prior.results.map((r) => ({
      domain: r.domain,
      hash: r.passA.viaWww ? null : r.passA.hash,
      textHash: r.passA.viaWww ? null : r.passA.textHash,
      validators: r.passA.viaWww ? null : r.passA.validators,
    })),
  }
}

const expandPath = (p: string): string =>
  isAbsolute(p) ? p : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(process.cwd(), p)

const flag = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

const numFlag = (name: string, fallback: number): number => {
  const raw = flag(name)
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    console.error(`--${name} must be a positive integer`)
    process.exit(1)
  }
  return parsed
}

const sha16 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** What the V2 baseline hashed: the whole document, whitespace collapsed. */
const hashDocument = (body: string): string => sha16(body.replace(/\s+/g, ' ').trim())

/**
 * Visible text only. The document hash also covers script bodies and tag
 * attributes, so a per-request nonce, CSRF token or cache-buster moves it
 * without a word on the page changing — which is the difference between a
 * change signal and a random number.
 */
const hashVisibleText = (body: string): string =>
  sha16(
    body
      .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  )

/** What the server offers for conditional GET, HTTP's own change signal. */
type Validators = { etag: string | null; lastModified: string | null }

type FetchOutcome =
  | { ok: true; url: string; status: number; body: string; validators: Validators }
  | { ok: false; url: string; notModified: boolean; status: number | null; error: string }

async function fetchCapped(
  url: string,
  maxBytes: number,
  conditional?: Validators,
): Promise<FetchOutcome> {
  const headers: Record<string, string> = { 'user-agent': USER_AGENT, accept: '*/*' }
  if (conditional?.etag !== null && conditional?.etag !== undefined) {
    headers['if-none-match'] = conditional.etag
  }
  if (conditional?.lastModified !== null && conditional?.lastModified !== undefined) {
    headers['if-modified-since'] = conditional.lastModified
  }
  let res: Response
  try {
    res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (e) {
    return {
      ok: false,
      url,
      notModified: false,
      status: null,
      error: e instanceof Error ? e.name : 'fetch_failed',
    }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return {
      ok: false,
      url: res.url,
      notModified: res.status === 304,
      status: res.status,
      error: `http_${res.status}`,
    }
  }
  const validators: Validators = {
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  }
  const reader = res.body?.getReader()
  if (reader === undefined) {
    return { ok: true, url: res.url, status: res.status, body: '', validators }
  }
  const decoder = new TextDecoder()
  let body = ''
  let bytes = 0
  try {
    while (bytes < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    // Without a final call the decoder keeps a trailing partial sequence to
    // itself, silently shortening the body the hash is taken over.
    body += decoder.decode()
  } catch (e) {
    return {
      ok: false,
      url: res.url,
      notModified: false,
      status: res.status,
      error: e instanceof Error ? e.name : 'read_failed',
    }
  } finally {
    await reader.cancel()
  }
  return { ok: true, url: res.url, status: res.status, body, validators }
}

type HomeProbe = {
  hash: string | null
  textHash: string | null
  finalUrl: string | null
  status: number | null
  error: string | null
  viaWww: boolean
  at: number
  validators: Validators
  /** Set on pass B: the server answered 304 to pass A's validators. */
  notModified: boolean
}

const NO_VALIDATORS: Validators = { etag: null, lastModified: null }

/**
 * https → http on the apex, mirroring the order the baseline used; www is a
 * last resort and flagged, because hashing a different host is not a diff
 * against the baseline's page.
 */
async function probeHome(domain: string, conditional?: Validators): Promise<HomeProbe> {
  const attempts: { url: string; viaWww: boolean }[] = [
    { url: `https://${domain}/`, viaWww: false },
    { url: `http://${domain}/`, viaWww: false },
    { url: `https://www.${domain}/`, viaWww: true },
  ]
  let last: FetchOutcome | null = null
  for (const { url, viaWww } of attempts) {
    const res = await fetchCapped(url, MAX_HTML_BYTES, conditional)
    if (res.ok) {
      return {
        hash: hashDocument(res.body),
        textHash: hashVisibleText(res.body),
        finalUrl: res.url,
        status: res.status,
        error: null,
        viaWww,
        at: Date.now(),
        validators: res.validators,
        notModified: false,
      }
    }
    // 304 is the answer, not a failure: the server says nothing changed, so
    // there is no body to hash and no reason to try the next host.
    if (res.notModified) {
      return {
        hash: null,
        textHash: null,
        finalUrl: res.url,
        status: res.status,
        error: null,
        viaWww,
        at: Date.now(),
        validators: conditional ?? NO_VALIDATORS,
        notModified: true,
      }
    }
    last = res
  }
  return {
    hash: null,
    textHash: null,
    finalUrl: null,
    status: last?.status ?? null,
    error: last === null || last.ok ? 'unreachable' : last.error,
    viaWww: false,
    at: Date.now(),
    validators: NO_VALIDATORS,
    notModified: false,
  }
}

type SitemapProbe = {
  source: string | null
  entries: number
  withLastmod: number
  // A sitemap that stamps every URL with the same lastmod is reporting its
  // build time, not per-page edits: it can say "the site rebuilt" but never
  // "the news page changed", which is exactly what T1 would need from it.
  distinctLastmods: number
  eventPath: number
  eventPathWithLastmod: number
  withinWindow: number
  eventWithinWindow: number
  freshestLastmod: number | null
  freshestEventLastmod: number | null
  recentEventUrls: { loc: string; lastmod: number }[]
}

const EMPTY_SITEMAP: SitemapProbe = {
  source: null,
  entries: 0,
  withLastmod: 0,
  distinctLastmods: 0,
  eventPath: 0,
  eventPathWithLastmod: 0,
  withinWindow: 0,
  eventWithinWindow: 0,
  freshestLastmod: null,
  freshestEventLastmod: null,
  recentEventUrls: [],
}

function summarizeEntries(
  entries: readonly SitemapEntry[],
  domain: string,
  source: string,
  windowStart: number,
): SitemapProbe {
  const sameSite = entries.filter((e) => isSameSite(e.loc, domain))
  const dated = sameSite.filter((e): e is { loc: string; lastmod: number } => e.lastmod !== null)
  const event = sameSite.filter((e) => isEventPath(e.loc))
  const eventDated = dated.filter((e) => isEventPath(e.loc))
  const max = (xs: readonly { lastmod: number }[]): number | null =>
    xs.length === 0 ? null : Math.max(...xs.map((e) => e.lastmod))
  return {
    source,
    entries: sameSite.length,
    withLastmod: dated.length,
    distinctLastmods: new Set(dated.map((e) => e.lastmod)).size,
    eventPath: event.length,
    eventPathWithLastmod: eventDated.length,
    withinWindow: dated.filter((e) => e.lastmod >= windowStart).length,
    eventWithinWindow: eventDated.filter((e) => e.lastmod >= windowStart).length,
    freshestLastmod: max(dated),
    freshestEventLastmod: max(eventDated),
    recentEventUrls: [...eventDated]
      .sort((a, b) => b.lastmod - a.lastmod)
      .slice(0, RECENT_EVENT_URLS)
      .map((e) => ({ loc: e.loc, lastmod: e.lastmod })),
  }
}

async function fetchSitemap(url: string): Promise<ReturnType<typeof parseSitemap>> {
  const res = await fetchCapped(url, MAX_SITEMAP_BYTES)
  return res.ok ? parseSitemap(res.body) : null
}

/** Mirrors resolveSignalUrls in services/org-signals.ts, keeping the entries. */
async function probeSitemap(domain: string, windowStart: number): Promise<SitemapProbe> {
  const robots = await fetchCapped(`https://${domain}/robots.txt`, 32 * 1024)
  const declared = robots.ok
    ? parseRobotsSitemaps(robots.body).filter((u) => isSameSite(u, domain))
    : []
  const candidates = orderByEventPreference([
    ...new Set([...declared, `https://${domain}/sitemap.xml`, `https://www.${domain}/sitemap.xml`]),
  ])

  let remaining = MAX_SITEMAP_FETCHES
  for (const candidate of candidates) {
    if (remaining <= 0) break
    remaining--
    const parsed = await fetchSitemap(candidate)
    if (parsed === null) continue

    let entries: SitemapEntry[] = []
    if (parsed.kind === 'urlset') {
      entries = parsed.entries
    } else if (remaining > 0) {
      const child = preferEventSitemap(parsed.locs)
      if (child !== undefined) {
        remaining--
        const childParsed = await fetchSitemap(child)
        entries = childParsed?.kind === 'urlset' ? childParsed.entries : []
      }
    }
    if (entries.length > 0) return summarizeEntries(entries, domain, candidate, windowStart)
  }
  return EMPTY_SITEMAP
}

type DomainResult = {
  domain: string
  baselineHash: string | null
  baselineTextHash: string | null
  passA: HomeProbe
  passB: HomeProbe
  passC: HomeProbe
  conditionalFromBaseline: boolean
  gapSeconds: number
  sitemap: SitemapProbe
}

async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) return
      out[index] = await worker(item, index)
    }
  })
  await Promise.all(runners)
  return out
}

const pct = (n: number, d: number): string => (d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`)

function report(results: readonly DomainResult[], windowDays: number): void {
  const line = (label: string, n: number, d: number) =>
    console.log(`  ${label.padEnd(46)} ${String(n).padStart(4)} / ${d}  ${pct(n, d)}`)

  const total = results.length
  const readA = results.filter((r) => r.passA.hash !== null)
  const readBoth = readA.filter((r) => r.passB.hash !== null)
  // A www answer is a different page than the baseline hashed, and a baseline
  // that never read the page has nothing to compare against.
  const comparable = readA.filter((r) => !r.passA.viaWww && r.baselineHash !== null)

  console.log(`\n=== Reachability (n=${total}) ===`)
  line('homepage read (pass A)', readA.length, total)
  line('└ only via www', readA.filter((r) => r.passA.viaWww).length, total)
  line('read twice (A and B)', readBoth.length, total)

  console.log(`\n=== Q1  hash-diff noise ===`)
  const noisy = readBoth.filter((r) => r.passA.hash !== r.passB.hash)
  const medGap =
    readBoth.length === 0
      ? 0
      : [...readBoth].sort((a, b) => a.gapSeconds - b.gapSeconds)[Math.floor(readBoth.length / 2)]!
          .gapSeconds
  const noisyText = readBoth.filter((r) => r.passA.textHash !== r.passB.textHash)
  console.log(`  per-request noise floor (two fetches ${(medGap / 60).toFixed(1)} min apart):`)
  line('whole document CHANGED  = pure noise', noisy.length, readBoth.length)
  line('visible text CHANGED    = pure noise', noisyText.length, readBoth.length)

  const changedVsBaseline = comparable.filter((r) => r.passA.hash !== r.baselineHash)
  console.log(`\n  vs baseline (${windowDays.toFixed(1)} days):`)
  line('whole document reproduced (unchanged)', comparable.length - changedVsBaseline.length, comparable.length)
  line('whole document CHANGED', changedVsBaseline.length, comparable.length)
  const textComparable = readA.filter((r) => !r.passA.viaWww && r.baselineTextHash !== null)
  if (textComparable.length === 0) {
    console.log('  (baseline carries no visible-text hash — re-run against this run to get it)')
  } else {
    line(
      'visible text CHANGED',
      textComparable.filter((r) => r.passA.textHash !== r.baselineTextHash).length,
      textComparable.length,
    )
  }

  // Only domains carrying lastmod can say whether a real update landed. Once a
  // baseline carries the text hash, that is the one worth calibrating.
  const useText = textComparable.length > 0
  const changedFrom = (r: DomainResult): boolean =>
    useText ? r.passA.textHash !== r.baselineTextHash : r.passA.hash !== r.baselineHash
  const withMarker = (useText ? textComparable : comparable).filter((r) => r.sitemap.withLastmod > 0)
  const markerChanged = withMarker.filter(changedFrom)
  const trueish = markerChanged.filter((r) => r.sitemap.withinWindow > 0)
  console.log(
    `\n  calibration on domains carrying sitemap lastmod (n=${withMarker.length}, ${useText ? 'visible text' : 'whole document'} hash):`,
  )
  line('hash changed', markerChanged.length, withMarker.length)
  line('└ lastmod also moved in window (true-ish)', trueish.length, markerChanged.length)
  line('└ no lastmod moved  = FALSE POSITIVE', markerChanged.length - trueish.length, markerChanged.length)
  const quiet = withMarker.filter((r) => !changedFrom(r) && r.sitemap.withinWindow > 0)
  line('hash SAME but lastmod moved = miss', quiet.length, withMarker.length)
  // A sitemap that stamps one build time on every URL cannot say which page
  // moved, so it is the weakest ground truth in the set — split it out.
  const perUrl = withMarker.filter((r) => r.sitemap.distinctLastmods > 1)
  const perUrlChanged = perUrl.filter(changedFrom)
  const perUrlTrue = perUrlChanged.filter((r) => r.sitemap.withinWindow > 0)
  console.log(`  same, build stamps excluded (n=${perUrl.length}):`)
  line('hash changed', perUrlChanged.length, perUrl.length)
  line('└ lastmod also moved in window (true-ish)', perUrlTrue.length, perUrlChanged.length)

  const overDays = results.some((r) => r.conditionalFromBaseline)
  console.log(
    `\n=== Q1b  conditional GET — ${overDays ? `over ${windowDays.toFixed(1)} days` : 'within the run'} ===`,
  )
  const offers = readA.filter(
    (r) => r.passA.validators.etag !== null || r.passA.validators.lastModified !== null,
  )
  line('offers ETag or Last-Modified', offers.length, readA.length)
  line('└ ETag', readA.filter((r) => r.passA.validators.etag !== null).length, readA.length)
  line(
    '└ Last-Modified',
    readA.filter((r) => r.passA.validators.lastModified !== null).length,
    readA.length,
  )
  const tested = overDays
    ? readA.filter((r) => r.conditionalFromBaseline)
    : offers
  const answered304 = tested.filter((r) => r.passC.notModified)
  line('└ honours it with 304', answered304.length, tested.length)
  // A 304 while the text demonstrably moved is the server asserting something
  // false — worse than offering no validator, because T1 believes it and skips
  // the domain. Over days the comparison that matters is against the baseline;
  // within one run, pass B is all there is.
  const lying = answered304.filter((r) =>
    overDays
      ? r.baselineTextHash !== null && r.passB.textHash !== null && r.baselineTextHash !== r.passB.textHash
      : r.passB.textHash !== null && r.passA.textHash !== r.passB.textHash,
  )
  line('   └ but the text changed anyway = LIES', lying.length, answered304.length)
  if (!overDays) {
    console.log('  (nothing real changes in ten minutes, so 0 lies here proves little —')
    console.log('   re-run against this run to test it over days)')
  }

  console.log(`\n=== Q2  does the sitemap localize what changed? ===`)
  const withSitemap = results.filter((r) => r.sitemap.entries > 0)
  const withLastmod = results.filter((r) => r.sitemap.withLastmod > 0)
  const withEvent = results.filter((r) => r.sitemap.eventPath > 0)
  const withEventDated = results.filter((r) => r.sitemap.eventPathWithLastmod > 0)
  line('same-site sitemap entries found', withSitemap.length, total)
  line('└ any entry carries lastmod', withLastmod.length, total)
  line('   └ one lastmod for all URLs = build stamp', withLastmod.filter((r) => r.sitemap.distinctLastmods === 1).length, withLastmod.length)
  line('└ any entry on an event path', withEvent.length, total)
  line('└ event-path entry WITH lastmod  (T1→T2)', withEventDated.length, total)
  line('   └ event lastmod within window', results.filter((r) => r.sitemap.eventWithinWindow > 0).length, total)
  console.log(`\n  localization among domains that moved in-window (n=${results.filter((r) => r.sitemap.withinWindow > 0).length}):`)
  const moved = results.filter((r) => r.sitemap.withinWindow > 0)
  line('└ the move is on an event path', moved.filter((r) => r.sitemap.eventWithinWindow > 0).length, moved.length)
}

async function main(): Promise<void> {
  const baselinePath = expandPath(flag('baseline') ?? '~/leadace-v2-baseline.json')
  const outPath = expandPath(flag('out') ?? '~/leadace-d1-preflight.json')
  const concurrency = numFlag('concurrency', 12)
  const limit = numFlag('limit', Number.MAX_SAFE_INTEGER)
  const gapSeconds = numFlag('gap', 600)

  if (!existsSync(baselinePath)) {
    console.error(`baseline not found: ${baselinePath}`)
    process.exit(1)
  }
  const baseline = readBaseline(JSON.parse(readFileSync(baselinePath, 'utf-8')))
  const rows: BaselineRow[] = baseline.rows.slice(0, limit)
  const measuredAt = Date.parse(baseline.measuredAt)
  const startedAt = Date.now()
  const windowDays = (startedAt - measuredAt) / DAY_MS

  console.log(
    `probing ${rows.length} domains (baseline ${baseline.measuredAt}, window ${windowDays.toFixed(1)}d, concurrency ${concurrency})`,
  )

  console.log('pass A: homepage …')
  const passA = await pool(rows, concurrency, (row) => probeHome(row.domain))

  console.log('sitemap …')
  const sitemaps = await pool(rows, concurrency, (row) => probeSitemap(row.domain, measuredAt))

  const elapsed = (Date.now() - startedAt) / 1000
  if (elapsed < gapSeconds) {
    console.log(`waiting ${Math.round(gapSeconds - elapsed)}s so pass B is ${gapSeconds}s past pass A …`)
    await new Promise((r) => setTimeout(r, (gapSeconds - elapsed) * 1000))
  }
  console.log('pass B: homepage again …')
  const passB = await pool(rows, concurrency, (row) => probeHome(row.domain))

  // Separate from pass B: a conditional request that 304s returns no body, so
  // folding it into pass B would drop exactly the quiet sites from the noise
  // denominator and flatter the result.
  //
  // Validators from the baseline when it has them, so the window under test is
  // the same days the hashes are compared over. Against pass A's own validators
  // a 304 only proves the server does not lie when there is nothing to lie
  // about; over days it has to answer 200 when the page really moved.
  const conditionalFromBaseline = rows.some((r) => r.validators !== null)
  console.log(
    `pass C: conditional GET against ${conditionalFromBaseline ? 'baseline' : 'pass A'} validators …`,
  )
  const passC = await pool(rows, concurrency, (row, i) =>
    probeHome(row.domain, row.validators ?? passA[i]!.validators),
  )

  const results: DomainResult[] = rows.map((row, i) => ({
    domain: row.domain,
    baselineHash: row.hash,
    baselineTextHash: row.textHash,
    passA: passA[i]!,
    passB: passB[i]!,
    passC: passC[i]!,
    conditionalFromBaseline: row.validators !== null,
    gapSeconds: Math.round((passB[i]!.at - passA[i]!.at) / 1000),
    sitemap: sitemaps[i]!,
  }))

  writeFileSync(
    outPath,
    JSON.stringify(
      { measuredAt: new Date(startedAt).toISOString(), baselineMeasuredAt: baseline.measuredAt, windowDays, results },
      null,
      2,
    ),
  )
  report(results, windowDays)
  console.log(`\nwrote ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
