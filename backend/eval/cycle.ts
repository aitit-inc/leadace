/**
 * Discover graded on what production pays per prospect it bills, pass after
 * pass, on ICPs it was never tuned on (#819). run.ts grades one cold pass on
 * precision; this runs the passes a project runs — search notes carried, every
 * earlier registration known — priced with the table `paid_calls` bills with.
 * What a pass is and how fit is judged: README.md.
 *
 * Usage (from backend/, OPENAI_API_KEY in .dev.vars):
 *   npx tsx eval/cycle.ts run   <target> --arm prod --passes 5
 *   npx tsx eval/cycle.ts judge <target> [--sample 25]   # snapshot billable prospects, write the blind queue
 *   npx tsx eval/cycle.ts audit <target>   # the sample a person re-judges into audit.json
 *   npx tsx eval/cycle.ts score <target>
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { extractionPrompt, extractionSchema, searchPrompt, shapeCandidates } from '../src/services/pipeline/discover'
import { enrichCandidate, verdictOf } from '../src/services/pipeline/enrich'
import { callLlmFollowUpJson, callLlmGroundedText, LlmError, type LlmEnv } from '../src/services/llm'
import { apexDomainOf, parseIndustryVocabulary } from '../src/services/pipeline/context'
import { discoverCandidateSchema, type DiscoverCandidate } from '../src/domain/jobs'
import { NO_TOKENS, paidCallCostUsd, type PaidCall } from '../src/domain/paid-calls'
import { utcDateKey } from '../src/domain/time'
import { envKey, labelsSchema, readJson, snapshotSite, specSchema, targetDir, VERDICTS, writeJson, type Verdict } from './common'

// An arm under test is added beside `prod` (README.md > Arms).
const ARMS = ['prod'] as const
type Arm = (typeof ARMS)[number]

const ENRICH_CONCURRENCY = 4

// --- paid calls ------------------------------------------------------------

// Production records each paid call inside a job's scope; here the `[llm]`
// record every call logs is caught instead, in the async context of the unit
// that made it, so concurrent enrich reads each keep their own.
const paidCallSchema = z.object({
  op: z.string(),
  model: z.string(),
  tier: z.string(),
  usage: z.object({ input: z.number(), cachedInput: z.number(), cacheWrite: z.number(), output: z.number(), thoughts: z.number(), searchCalls: z.number() }),
})
type Call = z.infer<typeof paidCallSchema>

const callScope = new AsyncLocalStorage<Call[]>()
const rawLog = console.log
const rawError = console.error
console.log = (...args: unknown[]): void => {
  const calls = callScope.getStore()
  const r = args[0] as Record<string, unknown> | null
  if (calls === undefined || typeof r !== 'object' || r === null || !String(r['message'] ?? '').startsWith('[llm]')) return rawLog(...args)
  const n = (k: string): number => (typeof r[k] === 'number' ? r[k] : 0)
  calls.push({
    op: String(r['op']),
    model: String(r['model']),
    tier: String(r['tier']),
    usage: { input: n('input'), cachedInput: n('cachedInput'), cacheWrite: n('cacheWrite'), output: n('output'), thoughts: n('thoughts'), searchCalls: n('searchCalls') },
  })
}
// Every call is "not recorded" here: there is no ledger to write to.
console.error = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].startsWith('[paid-calls]')) return
  rawError(...args)
}

async function paid<T>(fn: () => Promise<T>): Promise<{ value: T; calls: Call[] }> {
  const calls: Call[] = []
  const value = await callScope.run(calls, fn)
  return { value, calls }
}

function costOf(calls: Call[]): number {
  return calls.reduce((usd, c) => usd + paidCallCostUsd(c as PaidCall), 0)
}

const VERIFY_USD = paidCallCostUsd({ model: 'emailable', tier: 'default', usage: NO_TOKENS })

// --- records ---------------------------------------------------------------

const searchRecordSchema = z.object({
  strategy: z.string(),
  search: z.object({ text: z.string(), citations: z.array(z.object({ passage: z.string(), pages: z.array(z.string()) })), responseId: z.string() }).nullable(),
  unavailable: z.string().nullable(),
  calls: z.array(paidCallSchema),
})

const extractRecordSchema = z.object({
  strategy: z.string(),
  candidates: z.array(discoverCandidateSchema),
  notes: z.string().nullable(),
  unavailable: z.string().nullable(),
  calls: z.array(paidCallSchema),
})

const enrichRecordSchema = z.object({
  domain: z.string(),
  name: z.string(),
  websiteUrl: z.string(),
  strategy: z.string().nullable(),
  verdict: z.enum(['billable', 'unreachable', 'unqualified']).nullable(),
  skip: z.string().nullable(),
  calls: z.array(paidCallSchema),
})
type EnrichRecord = z.infer<typeof enrichRecordSchema>

// Written last, so its presence means the pass is complete.
const passRecordSchema = z.object({
  pass: z.number().int(),
  ranAt: z.string(),
  notesAfter: z.string().nullable(),
  found: z.number().int(),
  unique: z.number().int(),
  fresh: z.array(z.string()),
  // Domains production would now hold: every judged candidate registers,
  // whatever its verdict, so a later pass never reads it again.
  registered: z.array(z.string()),
})
type PassRecord = z.infer<typeof passRecordSchema>

function armDir(dir: string, arm: Arm): string {
  return resolve(dir, `cycle.${arm}`)
}

function passDir(dir: string, arm: Arm, n: number): string {
  return resolve(armDir(dir, arm), `p${n}`)
}

function readPass(dir: string, arm: Arm, n: number): PassRecord | null {
  const path = resolve(passDir(dir, arm, n), 'pass.json')
  return existsSync(path) ? readJson(path, passRecordSchema) : null
}

function completedPasses(dir: string, arm: Arm): PassRecord[] {
  const passes: PassRecord[] = []
  for (let n = 1; ; n++) {
    const p = readPass(dir, arm, n)
    if (p === null) return passes
    passes.push(p)
  }
}

function enrichRecords(dir: string, arm: Arm, pass: PassRecord): EnrichRecord[] {
  return pass.fresh.map((d) => readJson(resolve(passDir(dir, arm, pass.pass), 'enrich', `${d}.json`), enrichRecordSchema))
}

function stageCalls(dir: string, arm: Arm, n: number, stage: 'search' | 'extract'): Call[] {
  const at = passDir(dir, arm, n)
  return readdirSync(at)
    .filter((f) => f.startsWith(`${stage}.`))
    .flatMap((f) => readJson(resolve(at, f), z.object({ calls: z.array(paidCallSchema) })).calls)
}

// --- run -------------------------------------------------------------------

async function runPass(target: string, arm: Arm, n: number): Promise<void> {
  const dir = targetDir(target)
  if (readPass(dir, arm, n) !== null) return
  const earlier = completedPasses(dir, arm)
  if (earlier.length !== n - 1) throw new Error(`pass ${n} needs pass ${n - 1} complete first`)
  const spec = readJson(resolve(dir, 'spec.json'), specSchema)
  const env: LlmEnv = { OPENAI_API_KEY: envKey('OPENAI_API_KEY') }
  const industries = parseIndustryVocabulary(readFileSync(resolve(__dirname, '../seed-content/tpl_industries.md'), 'utf8'))
  const today = utcDateKey()
  const notesAtStart = earlier.at(-1)?.notesAfter ?? null
  const known = new Set(earlier.flatMap((p) => p.registered))
  const at = passDir(dir, arm, n)
  mkdirSync(resolve(at, 'enrich'), { recursive: true })
  process.stderr.write(`[cycle] ${target} ${arm} pass ${n} — ${known.size} known\n`)

  // Each unit lands on disk before the next needs it; a rerun buys only what
  // is missing.
  const searches = await Promise.all(
    spec.strategies.map(async (entry) => {
      const path = resolve(at, `search.${entry.slug}.json`)
      if (existsSync(path)) return readJson(path, searchRecordSchema)
      const args = { plan: entry, business: spec.business, salesStrategy: spec.salesStrategy, searchNotes: notesAtStart, learnings: null, reviewFeedback: null, targetCountries: spec.targetCountries, today }
      const prompt = searchPrompt(args)
      const { value, calls } = await paid(async () => {
        try {
          return { search: await callLlmGroundedText(env, 'discover.search', { prompt }), unavailable: null }
        } catch (e) {
          if (!(e instanceof LlmError)) throw e
          return { search: null, unavailable: e.message }
        }
      })
      const record = { strategy: entry.slug, ...value, calls }
      writeJson(path, record)
      process.stderr.write(`[cycle]   search ${entry.slug} — ${value.unavailable ?? `${calls.reduce((k, c) => k + c.usage.searchCalls, 0)} web_search`}, $${costOf(calls).toFixed(3)}\n`)
      return record
    }),
  )

  let notes = notesAtStart
  const found: DiscoverCandidate[] = []
  for (const s of searches) {
    const entry = spec.strategies.find((e) => e.slug === s.strategy)!
    if (s.search === null) continue
    const path = resolve(at, `extract.${entry.slug}.json`)
    let record = existsSync(path) ? readJson(path, extractRecordSchema) : null
    if (record === null) {
      const search = s.search
      const { value, calls } = await paid(async () => {
        try {
          const extracted = await callLlmFollowUpJson(env, 'discover.extract', {
            after: search,
            prompt: extractionPrompt({ search, industries, priorNotes: notes, today, strategySlug: entry.slug }),
            schema: extractionSchema,
          })
          return { candidates: shapeCandidates(extracted.candidates, entry, industries, search.citations), notes: extracted.searchNotes, unavailable: null }
        } catch (e) {
          if (!(e instanceof LlmError)) throw e
          return { candidates: [], notes: null, unavailable: e.message }
        }
      })
      record = { strategy: entry.slug, ...value, calls }
      writeJson(path, record)
      process.stderr.write(`[cycle]   extract ${entry.slug} — ${value.unavailable ?? `${value.candidates.length} candidates`}\n`)
    }
    found.push(...record.candidates)
    notes = record.notes ?? notes
  }

  const byDomain = new Map<string, DiscoverCandidate>()
  for (const c of found) {
    const domain = apexDomainOf(c.websiteUrl)
    if (domain !== null && !byDomain.has(domain)) byDomain.set(domain, c)
  }
  const fresh = [...byDomain.entries()].filter(([d]) => !known.has(d))

  const ctx = {
    procedure: readFileSync(resolve(__dirname, '../seed-content/tpl_enrich_contacts.md'), 'utf8'),
    offer: spec.business.split('\n').slice(0, 20).join('\n'),
    salesStrategy: spec.salesStrategy,
    approaches: spec.strategies.map((s) => s.approach),
    channels: ['email'] as const,
  }
  const todo = fresh.filter(([d]) => !existsSync(resolve(at, 'enrich', `${d}.json`)))
  for (let i = 0; i < todo.length; i += ENRICH_CONCURRENCY) {
    await Promise.all(
      todo.slice(i, i + ENRICH_CONCURRENCY).map(async ([domain, candidate]) => {
        const { value, calls } = await paid(() => enrichCandidate(env, candidate, ctx))
        const verdict = verdictOf(value.skip, value.qualified)
        writeJson(resolve(at, 'enrich', `${domain}.json`), { domain, name: candidate.name, websiteUrl: candidate.websiteUrl, strategy: candidate.discoveryStrategy ?? null, verdict, skip: value.skip, calls })
        process.stderr.write(`[cycle]   enrich ${domain} — ${verdict ?? value.skip}\n`)
      }),
    )
  }
  const enriched = fresh.map(([d]) => readJson(resolve(at, 'enrich', `${d}.json`), enrichRecordSchema))
  const pass: PassRecord = {
    pass: n,
    ranAt: new Date().toISOString(),
    notesAfter: notes,
    found: found.length,
    unique: byDomain.size,
    fresh: fresh.map(([d]) => d),
    registered: enriched.filter((e) => e.verdict !== null).map((e) => e.domain),
  }
  writeJson(resolve(at, 'pass.json'), pass)
}

async function run(target: string, arm: Arm, passes: number): Promise<void> {
  for (let n = 1; n <= passes; n++) await runPass(target, arm, n)
  score(target)
}

// --- judge / audit ---------------------------------------------------------

// Order by a hash of the domain: stable across reruns, unrelated to the arm.
// The audit draws from the judge's pick, so it salts the hash: the unsalted
// order again would favour the arm that had more to pick from.
function blindOrder(domains: string[], salt: 'judge' | 'audit'): string[] {
  const key = (d: string): string => createHash('sha256').update(salt === 'judge' ? d : `${salt}:${d}`).digest('hex')
  return [...domains].sort((a, b) => key(a).localeCompare(key(b)))
}

// Which billable domains each arm sent to the judge: an arm's fit rate is read
// on its own draw only, or a domain another arm also found is counted with a
// different chance of inclusion.
const judgeSampleSchema = z.record(z.string(), z.array(z.string()))

function billables(dir: string): Map<Arm, EnrichRecord[]> {
  return new Map(ARMS.map((arm) => [arm, completedPasses(dir, arm).flatMap((p) => enrichRecords(dir, arm, p)).filter((e) => e.verdict === 'billable')]))
}

function labelsOf(dir: string): z.infer<typeof labelsSchema> {
  const path = resolve(dir, 'labels.json')
  return existsSync(path) ? readJson(path, labelsSchema) : {}
}

// A person's re-judgment of the audit sample, which wins over the model's.
const auditSchema = z.record(z.string(), z.object({ verdict: z.enum(VERDICTS), note: z.string().nullable() }))

function auditOf(dir: string): z.infer<typeof auditSchema> {
  const path = resolve(dir, 'audit.json')
  return existsSync(path) ? readJson(path, auditSchema) : {}
}

// sample: at most this many billable domains per arm, drawn in blind order.
async function judge(target: string, sample: number | null): Promise<void> {
  const dir = targetDir(target)
  const urls = new Map<string, string>()
  const drawn: Record<string, string[]> = {}
  for (const [arm, records] of billables(dir)) {
    const byDomain = new Map(records.map((e) => [e.domain, e.websiteUrl]))
    drawn[arm] = blindOrder([...byDomain.keys()], 'judge').slice(0, sample ?? undefined)
    for (const d of drawn[arm]) urls.set(d, byDomain.get(d)!)
  }
  writeJson(resolve(dir, 'judge.sample.json'), drawn)
  const out = resolve(dir, 'snapshots')
  mkdirSync(out, { recursive: true })
  const entries = [...urls.entries()].filter(([d]) => !existsSync(resolve(out, `${d}.md`)))
  for (let i = 0; i < entries.length; i += 4) {
    await Promise.all(entries.slice(i, i + 4).map(async ([d, url]) => writeFileSync(resolve(out, `${d}.md`), await snapshotSite(url))))
  }
  const labels = labelsOf(dir)
  const queue = blindOrder([...urls.keys()].filter((d) => labels[d] === undefined), 'judge')
  writeJson(resolve(dir, 'judge.queue.json'), queue)
  console.log(`${urls.size} billable domains, ${queue.length} to judge → ${resolve(dir, 'judge.queue.json')}`)
}

function audit(target: string): void {
  const dir = targetDir(target)
  const labels = labelsOf(dir)
  const judged = blindOrder(Object.keys(labels), 'audit')
  const sample = judged.slice(0, Math.ceil(judged.length / 10))
  writeJson(resolve(dir, 'audit.sample.json'), sample)
  console.log(`audit ${sample.length} of ${judged.length} judged domains → ${resolve(dir, 'audit.sample.json')}; write verdicts into audit.json`)
}

// --- score -----------------------------------------------------------------

function usd(n: number): string {
  return `$${n.toFixed(3)}`
}

function score(target: string): void {
  const dir = targetDir(target)
  const labels = labelsOf(dir)
  const audited = auditOf(dir)
  const verdictOfDomain = (d: string): Verdict | null => audited[d]?.verdict ?? labels[d]?.verdict ?? null
  const samplePath = resolve(dir, 'judge.sample.json')
  const drawn = existsSync(samplePath) ? readJson(samplePath, judgeSampleSchema) : null

  for (const arm of ARMS) {
    const passes = completedPasses(dir, arm)
    if (passes.length === 0) continue
    console.log(`\n== ${target} — ${arm}`)
    console.log('pass  found  unique  fresh  billable  search+extract  enrich   verify   total    cum $/billable')
    let cumCost = 0
    const billableDomains: string[] = []
    const byStrategy = new Map<string, number[]>()
    for (const p of passes) {
      const enriched = enrichRecords(dir, arm, p)
      const billable = enriched.filter((e) => e.verdict === 'billable')
      const discover = costOf([...stageCalls(dir, arm, p.pass, 'search'), ...stageCalls(dir, arm, p.pass, 'extract')])
      const enrich = costOf(enriched.flatMap((e) => e.calls))
      const verify = billable.length * VERIFY_USD
      cumCost += discover + enrich + verify
      billableDomains.push(...billable.map((e) => e.domain))
      console.log(
        `${String(p.pass).padStart(4)}  ${String(p.found).padStart(5)}  ${String(p.unique).padStart(6)}  ${String(p.fresh.length).padStart(5)}  ${String(billable.length).padStart(8)}  ` +
          `${usd(discover).padStart(14)}  ${usd(enrich).padStart(6)}  ${usd(verify).padStart(6)}  ${usd(discover + enrich + verify).padStart(6)}  ${billableDomains.length === 0 ? 'n/a' : usd(cumCost / billableDomains.length)}`,
      )
      for (const e of billable) {
        const s = e.strategy ?? '(none)'
        const row = byStrategy.get(s) ?? Array.from({ length: passes.length }, () => 0)
        row[p.pass - 1]!++
        byStrategy.set(s, row)
      }
    }
    console.log('billable by strategy, per pass:')
    for (const [s, row] of byStrategy) console.log(`  ${s.padEnd(40)} ${row.join(' ')}`)

    const inDraw = drawn?.[arm] === undefined ? billableDomains : billableDomains.filter((d) => drawn[arm]!.includes(d))
    const verdicts = inDraw.map(verdictOfDomain)
    const settled = verdicts.filter((v) => v !== null && v !== 'unknown')
    const fit = settled.filter((v) => v === 'fit').length
    const unjudged = verdicts.filter((v) => v === null).length
    console.log(`fit among billable: ${settled.length === 0 ? 'n/a' : `${((fit / settled.length) * 100).toFixed(0)}% (${fit}/${settled.length})`}${unjudged > 0 ? `, ${unjudged} not judged yet` : ''}`)
  }
  const disagreements = Object.entries(audited).filter(([d, a]) => labels[d] !== undefined && labels[d].verdict !== a.verdict)
  if (Object.keys(audited).length > 0) console.log(`\naudit: ${Object.keys(audited).length} re-judged, ${disagreements.length} changed the model's verdict`)
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
  const namedArm = option('--arm') ?? 'prod'
  const arm = ARMS.find((a) => a === namedArm)
  if (arm === undefined) throw new Error(`unknown arm "${namedArm}" — expected ${ARMS.join(', ')}`)
  const passes = Number(option('--passes') ?? '1')
  const namedSample = option('--sample')
  const sample = namedSample === null ? null : Number(namedSample)
  if (sample !== null && !(Number.isInteger(sample) && sample >= 1)) throw new Error('--sample takes a positive integer')
  if (!(Number.isInteger(passes) && passes >= 1)) throw new Error('--passes takes a positive integer')
  const [command, target] = args
  if (target === undefined) throw new Error('usage: cycle.ts <run|judge|audit|score> <target> [--arm prod] [--passes <n>] [--sample <n>]')
  if (command === 'run') return run(target, arm, passes)
  if (command === 'judge') return judge(target, sample)
  if (command === 'audit') return audit(target)
  if (command === 'score') return score(target)
  throw new Error(`unknown command "${command ?? ''}" — expected run, judge, audit or score`)
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    rawError(e instanceof LlmError ? `${e.name}: ${e.message}` : e)
    process.exit(1)
  })
