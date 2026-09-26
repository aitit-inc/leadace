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
 * Usage (from backend/, OPENAI_API_KEY in .dev.vars). Every
 * command takes `--provider gemini|openai`, default openai; collect runs only
 * what production runs, which is openai. `--extractor <model>` extracts with
 * that model instead of the production route's; collect takes a comma list and
 * extracts every model from the same search:
 *   npx tsx eval/run.ts collect  <target>   # run production discover, write candidates.json
 *   npx tsx eval/run.ts snapshot <target>   # freeze page text for candidates + reference
 *   npx tsx eval/run.ts hits     <target>   # qualifying-term hits per snapshot, for the adjudicator
 *   npx tsx eval/run.ts score    <target>   # precision, coverage, verdict counts
 *   npx tsc --noEmit -p eval
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { extractionPrompt, extractionSchema, searchPrompt, shapeCandidates } from '../src/services/pipeline/discover'
import { callLlmGroundedText, LlmError, type GroundedText, type LlmEnv } from '../src/services/llm'
import { callOpenAIFollowUpJson } from '../src/services/llm/openai'
import { OPENAI_ROUTES } from '../src/services/llm/routes'
import { apexDomainOf, parseIndustryVocabulary } from '../src/services/pipeline/context'
import { utcDateKey } from '../src/domain/time'
import { discoverCandidateSchema } from '../src/domain/jobs'
import type { LlmModel } from '../src/domain/paid-calls'

const DATA = resolve(__dirname, 'data.local')

// Production discover runs on OpenAI. `gemini` names the runs collected before
// the switch, which still score against the same labels.
const PROVIDERS = ['gemini', 'openai'] as const
type Provider = (typeof PROVIDERS)[number]

// Which collection a command reads or writes. extractor null: the production
// route's model, under the names runs had before extractors could differ.
type Run = { provider: Provider; extractor: string | null }

// What a pass cost, in the units the `[llm]` log records.
const usageSchema = z.object({
  input: z.number(),
  cached: z.number(),
  output: z.number(),
  reasoning: z.number(),
  searchCalls: z.number(),
  searchQueries: z.number(),
})

type Usage = z.infer<typeof usageSchema>

const ZERO_USAGE: Usage = { input: 0, cached: 0, output: 0, reasoning: 0, searchCalls: 0, searchQueries: 0 }

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    cached: a.cached + b.cached,
    output: a.output + b.output,
    reasoning: a.reasoning + b.reasoning,
    searchCalls: a.searchCalls + b.searchCalls,
    searchQueries: a.searchQueries + b.searchQueries,
  }
}

// USD per 1M tokens by model, at list (standard-tier) price. Search bills per
// web_search call; Gemini billed grounding per unique query instead, so its
// runs price by queries.
const MODEL_PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
}
const SEARCH_PER_CALL = 0.01
const GROUNDING_PER_QUERY = 0.014

// Both providers report cached tokens inside input and bill them at the
// cached rate instead of the input rate, not on top of it.
function tokenCostOf(model: string, usage: Usage): number {
  const p = MODEL_PRICES[model]
  if (p === undefined) throw new Error(`no price for ${model}`)
  return (
    ((usage.input - usage.cached) / 1_000_000) * p.input +
    (usage.cached / 1_000_000) * p.cached +
    ((usage.output + usage.reasoning) / 1_000_000) * p.output
  )
}

// The harness runs in node, where `logUsage` writes its record to stdout, so a
// call's tokens and model can be read back without production returning them.
async function withUsage<T>(call: () => Promise<T>): Promise<{ value: T; usage: Usage; cost: number }> {
  const log = console.log
  let usage = ZERO_USAGE
  let cost = 0
  console.log = (...args: unknown[]): void => {
    const record = args[0]
    if (typeof record === 'object' && record !== null && String((record as { message?: unknown }).message ?? '').startsWith('[llm]')) {
      const r = record as Record<string, number>
      const call: Usage = {
        // Billed input is input + toolInput, per `LlmUsage` in services/llm/common.
        input: (r['input'] ?? 0) + (r['toolInput'] ?? 0),
        cached: r['cachedInput'] ?? 0,
        output: r['output'] ?? 0,
        reasoning: r['thoughts'] ?? 0,
        searchCalls: r['searchCalls'] ?? 0,
        searchQueries: r['searchQueries'] ?? 0,
      }
      usage = addUsage(usage, call)
      cost += tokenCostOf(String((record as { model?: unknown }).model), call) + call.searchCalls * SEARCH_PER_CALL
      return
    }
    log(...args)
  }
  try {
    return { value: await call(), usage, cost }
  } finally {
    console.log = log
  }
}

// A run collected before each pass recorded its own cost: one model per
// provider served both stages then.
function legacyCostOf(provider: Provider, usage: Usage): number {
  return provider === 'gemini'
    ? tokenCostOf('gemini-3.8-flash', usage) + usage.searchQueries * GROUNDING_PER_QUERY
    : tokenCostOf('gpt-5.6-luna', usage) + usage.searchCalls * SEARCH_PER_CALL
}

// Each provider writes beside the other, so both score against one label set.
// Gemini keeps the unsuffixed names, so a run collected before `--provider`
// existed still scores.
function runName({ provider, extractor }: Run): string {
  return extractor === null ? provider : `${provider}.${extractor}`
}

function passesDir(dir: string, run: Run): string {
  return resolve(dir, run.provider === 'gemini' ? 'passes' : `passes.${runName(run)}`)
}

function candidatesPath(dir: string, run: Run): string {
  return resolve(dir, run.provider === 'gemini' ? 'candidates.json' : `candidates.${runName(run)}.json`)
}

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
  provider: z.enum(PROVIDERS).default('gemini'),
  extractor: z.string().nullable().default(null),
  passes: z.array(
    z.object({
      strategy: z.string().min(1),
      searchQueries: z.number().int(),
      searchText: z.string(),
      candidates: z.array(discoverCandidateSchema),
      extractionFailed: z.string().nullable().default(null),
      usage: usageSchema.nullable().default(null),
      cost: z.number().nullable().default(null),
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

function envKey(name: string): string {
  const devVars = resolve(__dirname, '../.dev.vars')
  if (!existsSync(devVars)) throw new Error(`${devVars} not found — run from backend/ with a .dev.vars`)
  const pattern = new RegExp(`^${name}\\s*=\\s*"?([^"\n]*?)"?\\s*$`)
  const key = readFileSync(devVars, 'utf8')
    .split('\n')
    .flatMap((l) => {
      const m = l.match(pattern)
      return m?.[1] ? [m[1]] : []
    })[0]
  if (!key) throw new Error(`${name} missing from backend/.dev.vars`)
  return key
}

// --- collect ---------------------------------------------------------------

// One retry on an upstream stumble (timeout / 5xx / empty output): a failed
// call is a transport fact, not a measurement.
async function onceMore<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call()
  } catch (e) {
    if (!(e instanceof LlmError)) throw e
    process.stderr.write(`[collect] ${label} failed (${e.message}) — retrying once\n`)
    return call()
  }
}

function extract(env: LlmEnv, extractor: string | null, args: { after: GroundedText; prompt: string }): Promise<z.infer<typeof extractionSchema>> {
  const route = OPENAI_ROUTES['discover.extract']
  // The eval compares models production does not price; its calls run outside
  // a paid-call scope, so none of them reaches the ledger.
  const model = (extractor ?? route.model) as LlmModel
  return callOpenAIFollowUpJson({ op: 'discover.extract', apiKey: env.OPENAI_API_KEY, ...route, model, ...args, schema: extractionSchema })
}

async function collect(target: string, provider: Provider, extractors: (string | null)[]): Promise<void> {
  if (provider !== 'openai') throw new Error('collect runs production discover, which runs on openai; gemini runs can only be scored')
  const runs = extractors.map((extractor) => ({ provider, extractor }))
  const dir = targetDir(target)
  const spec = readJson(resolve(dir, 'spec.json'), specSchema)
  const env: LlmEnv = { OPENAI_API_KEY: envKey('OPENAI_API_KEY') }
  const industries = parseIndustryVocabulary(readFileSync(resolve(__dirname, '../seed-content/tpl_industries.md'), 'utf8'))
  const today = utcDateKey()

  // Serial and with searchNotes null: every pass must face the same blank
  // slate, or a later pass is scored on knowledge the earlier one bought.
  // Each pass lands on disk before the next starts, because a search is paid
  // for per call — delete a pass file to re-buy just that one. Extractors
  // compared on one search are rewritten together, so a pair never mixes two
  // searches.
  for (const run of runs) mkdirSync(passesDir(dir, run), { recursive: true })
  const passSchema = candidatesSchema.shape.passes.element
  const unfinished: string[] = []
  for (const entry of spec.strategies) {
    const passPaths = runs.map((run) => resolve(passesDir(dir, run), `${entry.slug}.json`))
    if (passPaths.every((p) => existsSync(p))) {
      process.stderr.write(`[collect] ${entry.slug} — already collected, skipping\n`)
      continue
    }
    process.stderr.write(`[collect] ${entry.slug}\n`)
    const prompt = searchPrompt({
      plan: entry,
      business: spec.business,
      salesStrategy: spec.salesStrategy,
      searchNotes: null,
      learnings: null,
      reviewFeedback: null,
      targetCountries: spec.targetCountries,
      today,
    })
    let search: GroundedText
    let searchUsage: Usage
    let searchCost: number
    try {
      const searched = await onceMore(`${entry.slug} search`, () => withUsage(() => callLlmGroundedText(env, 'discover.search', { prompt })))
      search = searched.value
      searchUsage = searched.usage
      searchCost = searched.cost
    } catch (e) {
      // No pass file: the search never landed, so a rerun re-buys only this one.
      if (!(e instanceof LlmError)) throw e
      process.stderr.write(`[collect] ${entry.slug} — search unavailable (${e.message}), moving on\n`)
      unfinished.push(entry.slug)
      continue
    }

    const extractPrompt = extractionPrompt({ search, industries, priorNotes: null, today, strategySlug: entry.slug })
    // Each pass carries the search's cost too, so it reads as one production pass.
    for (const [i, run] of runs.entries()) {
      let extracted: z.infer<typeof extractionSchema> | null = null
      let extractionFailed: string | null = null
      let usage = searchUsage
      let cost = searchCost
      try {
        const result = await onceMore(`${entry.slug} extraction (${runName(run)})`, () => withUsage(() => extract(env, run.extractor, { after: search, prompt: extractPrompt })))
        extracted = result.value
        usage = addUsage(usage, result.usage)
        cost += result.cost
      } catch (e) {
        if (!(e instanceof LlmError)) throw e
        extractionFailed = e.message
      }
      const candidates = shapeCandidates(extracted?.candidates ?? [], entry, industries, search.citations)
      writeJson(passPaths[i]!, {
        strategy: entry.slug,
        searchQueries: usage.searchQueries,
        searchText: search.text,
        candidates,
        extractionFailed,
        usage,
        cost,
      })
    }
  }

  for (const run of runs) {
    const passes = spec.strategies.flatMap((s) => {
      const passPath = resolve(passesDir(dir, run), `${s.slug}.json`)
      return existsSync(passPath) ? [readJson(passPath, passSchema)] : []
    })
    const out = candidatesPath(dir, run)
    writeJson(out, { collectedAt: new Date().toISOString(), specFrozenAt: spec.frozenAt, provider, extractor: run.extractor, passes })
    const total = passes.reduce((n, p) => n + p.candidates.length, 0)
    const queries = passes.reduce((n, p) => n + p.searchQueries, 0)
    console.log(`collected ${total} candidates over ${passes.length}/${spec.strategies.length} strategies, ${queries} search queries → ${out}`)
    for (const p of passes.filter((x) => x.extractionFailed !== null)) console.log(`  extraction failed after a retry: ${p.strategy} — ${p.extractionFailed ?? ''}`)
  }
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

async function snapshot(target: string, run: Run): Promise<void> {
  const dir = targetDir(target)
  const out = resolve(dir, 'snapshots')
  mkdirSync(out, { recursive: true })
  const sites = new Map<string, string>()
  for (const p of readJson(candidatesPath(dir, run), candidatesSchema).passes) {
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

function score(target: string, run: Run): void {
  const dir = targetDir(target)
  const collected = readJson(candidatesPath(dir, run), candidatesSchema)
  const labels = readJson(resolve(dir, 'labels.json'), labelsSchema)
  const domainsOf = (urls: string[]): string[] => [...new Set(urls.flatMap((u) => apexDomainOf(u) ?? []))]

  console.log(`\n== ${target} — ${runName(collected)} (collected ${collected.collectedAt.slice(0, 10)}, spec frozen ${collected.specFrozenAt})`)

  // A pass with zero search queries answered from the model's memory, which
  // the design forbids as a source of candidates. The OpenAI API can omit a
  // completed search's query metadata, so a pass with recorded calls is not
  // memory-only however its query count reads.
  const perStrategy = collected.passes.map((pass) => {
    const domains = domainsOf(pass.candidates.map((c) => c.websiteUrl))
    const labelled = domains.flatMap((d) => labels[d] ?? [])
    return {
      slug: pass.strategy,
      searchQueries: pass.searchQueries,
      searched: pass.searchQueries > 0 || (pass.usage?.searchCalls ?? 0) > 0,
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
        `${s.searched ? '' : '  ← no search ran: answered from model memory'}${s.extractionFailed !== null ? `  ← extraction failed: ${s.extractionFailed}` : ''}`,
    )
  }

  // What the run cost at list price, over the passes that reported tokens.
  const measured = collected.passes.flatMap((p) => (p.usage === null ? [] : [{ usage: p.usage, cost: p.cost }]))
  if (measured.length > 0) {
    const total = measured.map((m) => m.usage).reduce(addUsage, ZERO_USAGE)
    const cost = measured.reduce((n, m) => n + (m.cost ?? legacyCostOf(collected.provider, m.usage)), 0)
    console.log(
      `\ntokens in ${total.input.toLocaleString()} (cached ${total.cached.toLocaleString()}) out ${(total.output + total.reasoning).toLocaleString()}` +
        `  search ${total.searchCalls} calls / ${total.searchQueries} queries`,
    )
    console.log(`list-price cost $${cost.toFixed(3)} for ${measured.length} passes ($${(cost / measured.length).toFixed(3)} per pass)`)
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

// --- hits ------------------------------------------------------------------

const signalsSchema = z.object({ terms: z.array(z.string().min(1)).min(1) })

// The URLs `snapshot` writes as headings are this harness's own text, not the
// page's: `mcpjam.com` reads as two hits for "mcp" with nothing in the body.
function pageText(snapshot: string): string {
  return snapshot.replace(/^#{1,2} https?:\/\/\S+.*$/gm, '')
}

// Literal, case-insensitive, non-overlapping; the first three excerpts only.
// Matched on the original text, because lowercasing moves offsets (`İ` grows).
function termHits(body: string, term: string): { count: number; excerpts: string[] } {
  const at = [...body.matchAll(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'))].map((m) => m.index)
  return {
    count: at.length,
    excerpts: at.slice(0, 3).map((i) => body.slice(Math.max(0, i - 100), i + term.length + 100).replace(/\s+/g, ' ').trim()),
  }
}

// A command of its own because the order is the point: the counts have to be in
// front of the adjudicator before a verdict is written (README.md).
function hits(target: string, run: Run): void {
  const dir = targetDir(target)
  const collected = readJson(candidatesPath(dir, run), candidatesSchema)
  const { terms } = readJson(resolve(dir, 'signals.json'), signalsSchema)
  const snapshots = resolve(dir, 'snapshots')

  // Reference entries too: coverage counts them, so they carry verdicts, so
  // they need the same evidence in front of the adjudicator.
  const rows = new Map<string, { title: string; claim: string }>()
  for (const pass of collected.passes) {
    for (const c of pass.candidates) {
      const domain = apexDomainOf(c.websiteUrl)
      if (domain !== null && !rows.has(domain)) rows.set(domain, { title: `${c.name} [${pass.strategy}]`, claim: c.matchReason })
    }
  }
  const refPath = resolve(dir, 'reference.json')
  if (existsSync(refPath)) {
    for (const e of readJson(refPath, referenceSchema).entries) {
      const domain = apexDomainOf(e.websiteUrl)
      if (domain !== null && !rows.has(domain)) rows.set(domain, { title: `${e.name} [reference]`, claim: e.why })
    }
  }

  console.log(`# ${target} — qualifying signal hits (spec frozen ${collected.specFrozenAt})\n`)
  console.log(`terms: ${terms.join(' | ')}\n`)
  for (const [domain, { title, claim }] of rows) {
    console.log(`## ${domain} — ${title}`)
    console.log(`claim: ${claim}`)
    const path = resolve(snapshots, `${domain}.md`)
    if (!existsSync(path)) {
      console.log('snapshot: missing — run `snapshot` first\n')
      continue
    }
    const snapshot = readFileSync(path, 'utf8')
    const failed = (snapshot.match(/FETCH FAILED/g) ?? []).length
    console.log(`snapshot: ${snapshot.length} chars${failed > 0 ? `, ${failed} page(s) FETCH FAILED` : ''}`)
    const body = pageText(snapshot)
    const counted = terms.map((term) => ({ term, ...termHits(body, term) }))
    for (const row of counted.filter((r) => r.count > 0)) {
      console.log(`  ${row.term} — ${row.count}`)
      for (const e of row.excerpts) console.log(`      …${e}…`)
    }
    const absent = counted.filter((r) => r.count === 0).map((r) => r.term)
    if (absent.length > 0) console.log(`  absent: ${absent.join(' | ')}`)
    console.log(`  total ${counted.reduce((n, r) => n + r.count, 0)}\n`)
  }
}

// --- main ------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (name: string): string | null => {
    const at = args.indexOf(name)
    if (at === -1) return null
    const value = args[at + 1] ?? ''
    args.splice(at, 2)
    return value
  }
  const named = option('--provider') ?? 'openai'
  const provider = PROVIDERS.find((p) => p === named)
  if (provider === undefined) throw new Error(`unknown provider "${named}" — expected ${PROVIDERS.join(' or ')}`)
  const extractors = option('--extractor')?.split(',') ?? [null]
  // Checked before collect buys a search it could not price or file.
  for (const m of extractors) if (m !== null && MODEL_PRICES[m] === undefined) throw new Error(`no price for extractor "${m}" — expected one of ${Object.keys(MODEL_PRICES).join(', ')}`)
  if (new Set(extractors).size < extractors.length) throw new Error('an extractor is named twice')
  if (provider === 'gemini' && extractors[0] !== null) throw new Error('--extractor names OpenAI runs only')
  const [command, target] = args
  if (target === undefined) throw new Error('usage: run.ts <collect|snapshot|hits|score> <target> [--provider gemini|openai] [--extractor <model>[,<model>…]]')
  if (command === 'collect') return collect(target, provider, extractors)
  const [extractor, ...more] = extractors
  if (extractor === undefined || more.length > 0) throw new Error(`${command ?? ''} reads one run — pass one --extractor`)
  const run = { provider, extractor }
  if (command === 'snapshot') return snapshot(target, run)
  if (command === 'hits') return hits(target, run)
  if (command === 'score') return score(target, run)
  throw new Error(`unknown command "${command ?? ''}" — expected collect, snapshot, hits or score`)
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e instanceof LlmError ? `${e.name}: ${e.message}` : e)
    process.exit(1)
  })
