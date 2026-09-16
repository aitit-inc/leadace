/**
 * List-quality evaluation harness (README.md here; results are written up in
 * docs/list_quality.local.md).
 *
 * The subjects under test are the production prompts
 * (`services/pipeline/discover.ts`) imported directly — no reimplementation.
 * Verdicts are written by hand into labels.json; nothing here judges fit.
 * Snapshots freeze the page text a verdict rests on so a later run scores the
 * same evidence even after the sites move on.
 *
 * What it does NOT measure: `collect` runs every pass cold — searchNotes null,
 * no dedup against the tenant's pool — so passes stay comparable. That buys
 * comparability at the cost of saying nothing about supply durability, novelty
 * against what is already held, or portfolio breadth. Precision here is the
 * first batch from a blank slate, never the twentieth — measured against the
 * live pool it fell from 61% to 46%, because a third of what a cold pass
 * returns is already held. `supply.ts` reads those axes out of production.
 * The criteria this number has to be read beside: docs/list_quality.local.md §2.
 *
 * Non-deploy asset, like `sim/` and `scripts/probe-*.ts`. Target data lives in
 * `eval/data.local/<target>/` and never leaves this machine.
 *
 * Usage (from backend/, GEMINI_API_KEY in .dev.vars):
 *   npx tsx eval/run.ts collect  <target>   # run production discover, write candidates.json
 *   npx tsx eval/run.ts snapshot <target>   # freeze page text for candidates + reference
 *   npx tsx eval/run.ts score    <target>   # precision, coverage, verdict counts
 *   npx tsc --noEmit -p eval
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { extractionPrompt, extractionSchema, passageUrls, searchPrompt, sourcedSignals } from '../src/services/pipeline/discover'
import { callGeminiGroundedText, callGeminiJson, GeminiError, HOSTED_MODEL, type GroundedText } from '../src/services/gemini'
import { apexDomainOf, parseIndustryVocabulary } from '../src/services/pipeline/context'
import { utcDateKey } from '../src/domain/time'
import { discoverCandidateSchema, type DiscoverCandidate } from '../src/domain/jobs'

const DATA = resolve(__dirname, 'data.local')

// Verdict meanings: README.md. `unreachable` is a fit with no contact channel,
// a loss of the enrich stage, counted apart so it never flatters precision.
export const VERDICTS = [
  'fit',
  'unreachable',
  'not_an_org',
  'url_dead',
  'prereq_unmet',
  'not_a_fit',
  'fabricated_reason',
  'duplicate',
  'unknown',
] as const
export type Verdict = (typeof VERDICTS)[number]

const specSchema = z.object({
  slug: z.string().min(1),
  frozenAt: z.string().min(1),
  business: z.string().min(1),
  salesStrategy: z.string().min(1),
  targetCountries: z.array(z.string()),
  strategies: z.array(z.object({ slug: z.string().min(1), approach: z.string().min(1), count: z.number().int().positive() })).min(1),
})

const referenceSchema = z.object({
  builtAt: z.string().min(1),
  method: z.string().min(1),
  entries: z.array(
    z.object({
      name: z.string().min(1),
      websiteUrl: z.string().min(1),
      why: z.string().min(1),
      foundVia: z.string().min(1),
    }),
  ),
})

// How much of a verdict rests on opinion. `page-fact`: the frozen snapshot
// states it outright, so a second adjudicator reaches the same verdict.
// `judgment`: it took weighing, so it moves with whoever is judging. Precision
// is reported split by this, because a number built mostly on judgment is a
// different kind of number.
export const BASES = ['page-fact', 'judgment'] as const
export type Basis = (typeof BASES)[number]

const labelsSchema = z.record(
  z.string(),
  z.object({
    verdict: z.enum(VERDICTS),
    basis: z.enum(BASES),
    reason: z.string().min(1),
    evidenceUrl: z.string().nullable(),
    quote: z.string().nullable(),
    by: z.string().min(1),
  }),
)

const candidatesSchema = z.object({
  collectedAt: z.string().min(1),
  specFrozenAt: z.string().min(1),
  passes: z.array(
    z.object({
      strategy: z.string().min(1),
      searchQueries: z.number().int(),
      searchText: z.string(),
      candidates: z.array(discoverCandidateSchema),
      extractionFailed: z.string().nullable().default(null),
    }),
  ),
})

function targetDir(target: string): string {
  const dir = resolve(DATA, target)
  if (!existsSync(dir)) throw new Error(`${dir} not found — create the target's spec.json first (see eval/README.md)`)
  return dir
}

function readJson<T>(path: string, schema: z.ZodType<T>): T {
  if (!existsSync(path)) throw new Error(`${path} not found`)
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function geminiKey(): string {
  const devVars = resolve(__dirname, '../.dev.vars')
  if (!existsSync(devVars)) throw new Error(`${devVars} not found — run from backend/ with a .dev.vars`)
  const key = readFileSync(devVars, 'utf8')
    .split('\n')
    .flatMap((l) => {
      const m = l.match(/^GEMINI_API_KEY\s*=\s*"?([^"\n]*?)"?\s*$/)
      return m?.[1] ? [m[1]] : []
    })[0]
  if (!key) throw new Error('GEMINI_API_KEY missing from backend/.dev.vars')
  return key
}

// --- collect ---------------------------------------------------------------

// One retry on an upstream stumble, as the production job step has: the flex
// tier sheds under load (503 / timeout / empty output), and a shed pass is a
// transport fact, not a measurement.
async function onceMore<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!(e instanceof GeminiError)) throw e
    process.stderr.write(`[collect] ${label} failed (${e.message}) — retrying once\n`)
    return call()
  }
}

async function collect(target: string): Promise<void> {
  const dir = targetDir(target)
  const spec = readJson(resolve(dir, 'spec.json'), specSchema)
  const apiKey = geminiKey()
  const industries = parseIndustryVocabulary(readFileSync(resolve(__dirname, '../seed-content/tpl_industries.md'), 'utf8'))
  const today = utcDateKey()

  // Serial and with searchNotes null: every pass must face the same blank
  // slate, or a later pass is scored on knowledge the earlier one bought.
  // Each pass lands on disk before the next starts, because a search is paid
  // for in grounding queries — delete a pass file to re-buy just that one.
  const passDir = resolve(dir, 'passes')
  mkdirSync(passDir, { recursive: true })
  const passSchema = candidatesSchema.shape.passes.element
  const unfinished: string[] = []
  for (const entry of spec.strategies) {
    const passPath = resolve(passDir, `${entry.slug}.json`)
    if (existsSync(passPath)) {
      process.stderr.write(`[collect] ${entry.slug} — already collected, skipping\n`)
      continue
    }
    process.stderr.write(`[collect] ${entry.slug}\n`)
    let search: GroundedText
    try {
      search = await onceMore(`${entry.slug} search`, () =>
        callGeminiGroundedText({
          op: 'eval.search',
          tier: 'flex',
          apiKey,
          model: HOSTED_MODEL,
          timeoutMs: 180_000,
          prompt: searchPrompt({
            plan: entry,
            business: spec.business,
            salesStrategy: spec.salesStrategy,
            searchNotes: null,
            learnings: null,
            targetCountries: spec.targetCountries,
            today,
          }),
          maxOutputTokens: 8192,
        }),
      )
    } catch (e) {
      // No pass file: the search never landed, so a rerun re-buys only this one.
      if (!(e instanceof GeminiError)) throw e
      process.stderr.write(`[collect] ${entry.slug} — search unavailable (${e.message}), moving on\n`)
      unfinished.push(entry.slug)
      continue
    }

    let extracted: z.infer<typeof extractionSchema> | null = null
    let extractionFailed: string | null = null
    try {
      extracted = await onceMore(`${entry.slug} extraction`, () =>
        callGeminiJson({
          op: 'eval.extract',
          tier: 'flex',
          apiKey,
          model: HOSTED_MODEL,
          timeoutMs: 120_000,
          prompt: extractionPrompt({ search, industries, priorNotes: null, today, strategySlug: entry.slug }),
          schema: extractionSchema,
          maxOutputTokens: 16384,
        }),
      )
    } catch (e) {
      if (!(e instanceof GeminiError)) throw e
      extractionFailed = e.message
    }
    // The shaping runDiscover applies before enrich sees a candidate.
    const candidates: DiscoverCandidate[] = (extracted?.candidates ?? [])
      .filter((c) => apexDomainOf(c.websiteUrl) !== null)
      .map((c) => ({
        ...c,
        industry: industries.includes(c.industry) ? c.industry : 'Other',
        priority: c.priority as DiscoverCandidate['priority'],
        discoveryStrategy: entry.slug,
        matchSourceUrls: passageUrls(c.matchPassages, search.citations),
        signals: sourcedSignals(c.signals, search.citations),
      }))
      .slice(0, Math.ceil(entry.count * 1.5))
    writeJson(passPath, { strategy: entry.slug, searchQueries: search.searchQueries, searchText: search.text, candidates, extractionFailed })
  }

  const passes = spec.strategies.flatMap((s) => {
    const passPath = resolve(passDir, `${s.slug}.json`)
    return existsSync(passPath) ? [readJson(passPath, passSchema)] : []
  })
  writeJson(resolve(dir, 'candidates.json'), { collectedAt: new Date().toISOString(), specFrozenAt: spec.frozenAt, passes })
  const total = passes.reduce((n, p) => n + p.candidates.length, 0)
  const queries = passes.reduce((n, p) => n + p.searchQueries, 0)
  console.log(`collected ${total} candidates over ${passes.length}/${spec.strategies.length} strategies, ${queries} search queries → ${resolve(dir, 'candidates.json')}`)
  for (const p of passes.filter((x) => x.extractionFailed !== null)) console.log(`  extraction failed after a retry: ${p.strategy} — ${p.extractionFailed ?? ''}`)
  for (const slug of unfinished) console.log(`  search never landed, rerun to re-buy: ${slug}`)
}

// --- snapshot --------------------------------------------------------------

const EVIDENCE_PAGE = /about|company|corporate|profile|news|press|release|career|recruit|jobs|team|会社|企業|採用|お知らせ/i

function charsetOf(headerValue: string | null, head: string): string {
  const declared = headerValue?.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1]
  return (declared ?? 'utf-8').toLowerCase()
}

// A JP public-sector page declares Shift_JIS in <meta> only; decoding it as
// UTF-8 silently hands mojibake to whatever reads the snapshot next
// (source_driven_discovery.local.md §4.5).
function decode(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buf)
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  try {
    return new TextDecoder(charsetOf(contentType, head)).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function toText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
}

type Fetched = { url: string; status: number; html: string } | { url: string; error: string }

async function fetchPage(url: string): Promise<Fetched> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadAceEval/1.0)' },
    })
    const buf = await res.arrayBuffer()
    return { url: res.url, status: res.status, html: decode(buf, res.headers.get('content-type')) }
  } catch (e) {
    return { url, error: e instanceof Error ? e.message : String(e) }
  }
}

function linkedPages(html: string, base: string, limit: number): string[] {
  const origin = new URL(base).origin
  const urls = new Set<string>()
  for (const m of html.matchAll(/<a[^>]+href=["']([^"'#]+)["']/gi)) {
    const href = m[1]
    if (href === undefined) continue
    let abs: URL
    try {
      abs = new URL(href, base)
    } catch {
      continue
    }
    // mailto:, tel: and javascript: have an opaque origin, so this drops them too.
    if (abs.origin !== origin || !EVIDENCE_PAGE.test(abs.pathname)) continue
    if (abs.href !== base) urls.add(abs.href)
    if (urls.size >= limit) break
  }
  return [...urls]
}

async function snapshotSite(url: string): Promise<string> {
  const front = await fetchPage(url)
  if ('error' in front) return `# ${url}\n\nFETCH FAILED: ${front.error}\n`
  const parts = [`# ${url}\n\n## ${front.url} (HTTP ${front.status})\n\n${toText(front.html).slice(0, 12_000)}`]
  for (const link of linkedPages(front.html, front.url, 3)) {
    const page = await fetchPage(link)
    parts.push('error' in page ? `## ${link}\n\nFETCH FAILED: ${page.error}` : `## ${page.url} (HTTP ${page.status})\n\n${toText(page.html).slice(0, 8_000)}`)
  }
  return `${parts.join('\n\n')}\n`
}

async function snapshot(target: string): Promise<void> {
  const dir = targetDir(target)
  const out = resolve(dir, 'snapshots')
  mkdirSync(out, { recursive: true })
  const sites = new Map<string, string>()
  for (const p of readJson(resolve(dir, 'candidates.json'), candidatesSchema).passes) {
    for (const c of p.candidates) {
      const domain = apexDomainOf(c.websiteUrl)
      if (domain !== null && !sites.has(domain)) sites.set(domain, c.websiteUrl)
    }
  }
  const refPath = resolve(dir, 'reference.json')
  if (existsSync(refPath)) {
    for (const e of readJson(refPath, referenceSchema).entries) {
      const domain = apexDomainOf(e.websiteUrl)
      if (domain !== null && !sites.has(domain)) sites.set(domain, e.websiteUrl)
    }
  }

  const entries = [...sites.entries()]
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.all(
      entries.slice(i, i + 4).map(async ([domain, url]) => {
        const path = resolve(out, `${domain}.md`)
        if (existsSync(path)) return
        writeFileSync(path, await snapshotSite(url))
        process.stderr.write(`[snapshot] ${domain}\n`)
      }),
    )
  }
  console.log(`snapshots for ${entries.length} domains → ${out}`)
}

// --- score -----------------------------------------------------------------

function score(target: string): void {
  const dir = targetDir(target)
  const collected = readJson(resolve(dir, 'candidates.json'), candidatesSchema)
  const labels = readJson(resolve(dir, 'labels.json'), labelsSchema)
  const domainsOf = (urls: string[]): string[] => [...new Set(urls.flatMap((u) => apexDomainOf(u) ?? []))]

  console.log(`\n== ${target} (collected ${collected.collectedAt.slice(0, 10)}, spec frozen ${collected.specFrozenAt})`)

  // A pass with zero search queries answered from the model's memory, which
  // the design forbids as a source of candidates.
  const perStrategy = collected.passes.map((pass) => {
    const domains = domainsOf(pass.candidates.map((c) => c.websiteUrl))
    const labelled = domains.flatMap((d) => labels[d] ?? [])
    return {
      slug: pass.strategy,
      searchQueries: pass.searchQueries,
      candidates: pass.candidates.length,
      domains: domains.length,
      judged: labelled.filter((l) => l.verdict !== 'unknown').length,
      fit: labelled.filter((l) => l.verdict === 'fit').length,
      extractionFailed: pass.extractionFailed,
    }
  })
  for (const s of perStrategy) {
    const rate = s.judged === 0 ? 'n/a' : `${((s.fit / s.judged) * 100).toFixed(0)}%`
    console.log(
      `  ${s.slug.padEnd(32)} queries ${String(s.searchQueries).padStart(3)}  candidates ${String(s.candidates).padStart(3)}  fit ${s.fit}/${s.judged} (${rate})` +
        `${s.searchQueries === 0 ? '  ← no search ran: answered from model memory' : ''}${s.extractionFailed !== null ? `  ← extraction failed: ${s.extractionFailed}` : ''}`,
    )
  }

  // Overall precision is over unique domains: runDiscover dedups by domain
  // across passes before anything is registered, so a domain two strategies
  // both surfaced is one prospect, not two.
  const unique = domainsOf(collected.passes.flatMap((p) => p.candidates.map((c) => c.websiteUrl)))
  const counts = new Map<Verdict, number>()
  const unlabelled: string[] = []
  for (const domain of unique) {
    const label = labels[domain]
    if (label === undefined) {
      unlabelled.push(domain)
      continue
    }
    counts.set(label.verdict, (counts.get(label.verdict) ?? 0) + 1)
  }
  const labelled = [...counts.values()].reduce((a, b) => a + b, 0)
  // `unknown` is a failure of the evidence, not of the pipeline: it leaves the
  // denominator so precision never charges the pipeline for a page we could
  // not read, and is reported beside it so the gap stays visible.
  const settled = labelled - (counts.get('unknown') ?? 0)
  const fit = counts.get('fit') ?? 0
  const slots = collected.passes.reduce((n, p) => n + p.candidates.length, 0)
  console.log(`\ncandidate slots ${slots} → unique domains ${unique.length}; settled ${settled}, unknown ${counts.get('unknown') ?? 0}${unlabelled.length > 0 ? `, unlabelled ${unlabelled.length} (${unlabelled.slice(0, 5).join(', ')}${unlabelled.length > 5 ? ' …' : ''})` : ''}`)
  console.log(`precision ${settled === 0 ? 'n/a' : `${((fit / settled) * 100).toFixed(1)}% (${fit}/${settled})`}`)
  for (const v of VERDICTS) {
    const n = counts.get(v) ?? 0
    if (n > 0) console.log(`  ${v.padEnd(18)} ${n}`)
  }

  const byBasis = (b: Basis): { fit: number; settled: number } => {
    const rows = unique.flatMap((d) => labels[d] ?? []).filter((l) => l.basis === b && l.verdict !== 'unknown')
    return { fit: rows.filter((l) => l.verdict === 'fit').length, settled: rows.length }
  }
  for (const b of BASES) {
    const { fit: f, settled: n } = byBasis(b)
    if (n > 0) console.log(`  of which ${b.padEnd(10)} ${f}/${n} fit (${((f / n) * 100).toFixed(0)}%)`)
  }

  const refPath = resolve(dir, 'reference.json')
  if (!existsSync(refPath)) {
    console.log('\ncoverage: no reference.json yet')
    return
  }
  const reference = readJson(refPath, referenceSchema)
  // NOT recall. The reference is one enumerable source, never the whole
  // population, so a candidate outside it is not an error and a miss is not
  // proof the pipeline found something worse.
  const refFit = domainsOf(reference.entries.map((e) => e.websiteUrl)).filter((d) => {
    const v = labels[d]?.verdict
    return v === 'fit' || v === 'unreachable'
  })
  const found = new Set(unique)
  const hit = refFit.filter((d) => found.has(d))
  console.log(`\ncoverage of an enumerable qualifying source: ${refFit.length === 0 ? 'n/a' : `${hit.length}/${refFit.length} reached`} (${reference.method})`)
  console.log('  a miss here means the source is unexploited, not that the pipeline chose worse companies')
  if (hit.length > 0) console.log(`  reached: ${hit.join(', ')}`)
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const [command, target] = process.argv.slice(2)
  if (target === undefined) throw new Error('usage: run.ts <collect|snapshot|score> <target>')
  if (command === 'collect') return collect(target)
  if (command === 'snapshot') return snapshot(target)
  if (command === 'score') return score(target)
  throw new Error(`unknown command "${command ?? ''}" — expected collect, snapshot or score`)
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof GeminiError ? `Gemini: ${e.message}` : e)
    process.exit(1)
  })
