/**
 * Measures, before anything is changed (#531): what a full enrich read costs
 * per candidate and per registered prospect, how much of that is spent on
 * candidates that end without a usable channel, and whether a cheap
 * deterministic pre-check of the site's static HTML would have predicted that
 * outcome. Runs the production discover + enrichCandidate on fixed strategies
 * so before / after are comparable; the pre-check is script-local until the
 * numbers say it should ship.
 *
 * Usage (from backend/, OPENAI_API_KEY in .dev.vars):
 *   npx tsx scripts/probe-enrich-precheck.ts [strategy-slug] [--count=N] [--out=path.json]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractionPrompt, extractionSchema, searchPrompt, shapeCandidates } from '../src/services/pipeline/discover'
import { enrichCandidate } from '../src/services/pipeline/enrich'
import { callLlmFollowUpJson, callLlmGroundedText, LlmError, withLlmScope } from '../src/services/llm'
import { parseIndustryVocabulary, type HostedEnv } from '../src/services/pipeline/context'
import { utcDateKey } from '../src/domain/time'
import type { DiscoverCandidate } from '../src/domain/jobs'

const devVars = resolve(__dirname, '../.dev.vars')
if (!existsSync(devVars)) throw new Error(`${devVars} not found — run from backend/ with a .dev.vars`)
const vars = Object.fromEntries(
  readFileSync(devVars, 'utf8')
    .split('\n')
    .flatMap((l) => {
      const m = l.match(/^([A-Z_]+)\s*=\s*"?([^"\n]*?)"?\s*$/)
      return m ? [[m[1], m[2]]] : []
    }),
)
if (!vars['OPENAI_API_KEY']) throw new Error('OPENAI_API_KEY missing from backend/.dev.vars')
const env = { OPENAI_API_KEY: vars['OPENAI_API_KEY'] } as HostedEnv

const args = process.argv.slice(2)
const only = args.find((a) => !a.startsWith('--'))
const countArg = Number(args.find((a) => a.startsWith('--count='))?.slice(8) ?? '12')
const outPath = args.find((a) => a.startsWith('--out='))?.slice(6)

type Offer = { business: string; salesStrategy: string }

const leadace: Offer = {
  business: `# Business & Service Information
## Organization Overview
SurpassOne Inc. (Tokyo, founded 2023). Builds LeadAce.
## Service / Product Overview
LeadAce is an autonomous outbound sales agent for small B2B teams: it finds prospect organizations from registered discovery strategies, reads their websites for a contact and recent activity, writes a personalised first email grounded in what the site says, sends from the team's Gmail, and tracks replies.
## Features & Strengths
Every claim in an email is grounded in the prospect's own site; runs unattended on a schedule; built-in compliance (unsubscribe, do-not-contact, no-solicitation detection).
## Pricing
Free (30 prospects, lifetime), Starter $49/month for 100 prospects, Pro $99/month for 300.`,
  salesStrategy: `# Sales Strategy
## Target
Small B2B companies (10–50 people) that sell to other businesses and rely on outbound to grow: SaaS startups after a seed or Series A round, boutique agencies and consultancies, IT service firms. Decision maker: founder / CEO / head of sales.
## Prerequisites (observable)
- Has a product or service sold B2B with a public website in Japanese or English
- Evidence of outbound or sales capacity building: a sales / SDR / BDR job post, a recent funding round, a new sales lead hire, or a stated expansion
## Not a fit
Consumer brands, enterprises over 500 people, agencies that sell outbound services themselves (competitors), recruiting firms.
## Search Keywords
シード 資金調達 SaaS / シリーズA 資金調達 BtoB / インサイドセールス 募集 スタートアップ / seed round B2B SaaS / hiring SDR startup / boutique agency B2B`,
}

// A second offer whose candidates are institutions: the production case where
// most reads ended without a contact (education boards, public schools).
const education: Offer = {
  business: `# Business & Service Information
## Organization Overview
SpeechMonster (Tokyo). An AI English speaking-practice app for learners and schools.
## Service / Product Overview
Learners practise spoken English with an AI conversation partner; schools get class management and progress reports.
## Pricing
Per-seat school licence.`,
  salesStrategy: `# Sales Strategy
## Target
Language schools, ESL / EFL programs, community-college continuing-education departments and K-12 districts in the US and Canada that run English conversation programs. Decision maker: program director / coordinator.
## Prerequisites (observable)
- A public website describing an English conversation or ESL program
- A named program office or coordinator
## Not a fit
Universities' research departments, test-prep chains, consumer tutoring marketplaces.
## Search Keywords
ESL program community college / adult English conversation classes / language school English program coordinator`,
}

const strategies: Array<{ slug: string; approach: string; offer: Offer }> = [
  {
    slug: 'jp-funded-saas',
    approach:
      'Japanese B2B SaaS startups that announced a seed or Series A round in the last 90 days. Sources: PR TIMES (prtimes.jp) funding releases, INITIAL / STARTUP DB news, 日本経済新聞 スタートアップ, TechCrunch Japan / BRIDGE. Verify each on its official site.',
    offer: leadace,
  },
  {
    slug: 'us-boutique-agencies',
    approach:
      'US boutique B2B agencies and consultancies (10–50 people) with a public case-study page and an open sales / business-development role. Sources: Clutch and DesignRush directories, agency job posts on LinkedIn / Wellfound, "we are hiring" pages.',
    offer: leadace,
  },
  {
    slug: 'us-esl-programs',
    approach:
      'US and Canadian ESL / adult English conversation programs run by community colleges, public libraries, school districts and independent language schools. Sources: state adult-education directories, college continuing-education catalogues, TESOL program lists. Verify each on its official site.',
    offer: education,
  },
]

const industries = parseIndustryVocabulary(readFileSync(resolve(__dirname, '../seed-content/tpl_industries.md'), 'utf8'))
const procedure = readFileSync(resolve(__dirname, '../seed-content/tpl_enrich_contacts.md'), 'utf8')

type Usage = { jobId?: string; op: string; model: string; input: number; cachedInput: number; toolInput: number; output: number; thoughts: number; tier: string; searchCalls: number }
const usages: Usage[] = []
const log = console.log
console.log = (o: unknown) => {
  if (o && typeof o === 'object' && 'op' in o) usages.push(o as Usage)
}
// 2026 list prices per MTok by model; the flex tier is billed at half.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
  'gpt-6-luna': { input: 0.1, cached: 0.01, output: 0.5 },
  'gpt-6-sol': { input: 2, cached: 0.2, output: 10 },
}
const tokenCost = (u: Usage[]) =>
  u.reduce((a, x) => {
    const p = PRICES[x.model]
    if (!p) throw new Error(`no price for ${x.model}`)
    return a + (((x.input + x.toolInput - x.cachedInput) * p.input + x.cachedInput * p.cached + (x.output + x.thoughts) * p.output) / 1e6) * (x.tier === 'flex' ? 0.5 : 1)
  }, 0)
// Web search bills per call.
const SEARCH_PER_CALL = 0.01

// ---- the cheap pre-check under test: static HTML, no model -----------------

type PrecheckVerdict = 'email' | 'form' | 'none' | 'unreachable'
type Precheck = { verdict: PrecheckVerdict; pages: number; ms: number; evidence: string | null; emails: string[] }

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const EMAIL_NOISE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?)$|^[^@]*@(2x|3x)\b|sentry|wixpress|example\.|domain\.com|email\.com|yourdomain|schema\.org/i
const CONTACT_LINK_RE = /contact|inquir|enquir|get-in-touch|getintouch|reach-us|about|company|お問い合わせ|お問合せ|問い合わせ|問合せ|会社概要|企業情報/i
const FORM_RE = /<form[^>]*>[\s\S]*?<\/form>/gi

async function fetchHtml(url: string): Promise<{ status: number; html: string } | null> {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; LeadAceProbe/1.0)', accept: 'text/html,*/*' } })
    const html = res.status < 400 ? await res.text() : ''
    return { status: res.status, html: html.slice(0, 600_000) }
  } catch {
    return null
  }
}

function emailsIn(html: string): string[] {
  const found = new Set<string>()
  for (const m of html.matchAll(/mailto:([^"'?\s>]+)/gi)) {
    const a = decodeURIComponent(m[1]!).toLowerCase()
    if (!EMAIL_NOISE.test(a) && /@/.test(a)) found.add(a)
  }
  for (const m of html.matchAll(EMAIL_RE)) {
    const a = m[0].toLowerCase()
    if (!EMAIL_NOISE.test(a)) found.add(a)
  }
  return [...found]
}

function inquiryFormIn(html: string): boolean {
  for (const f of html.matchAll(FORM_RE)) {
    const form = f[0]
    if (/type=["']?search|role=["']?search|newsletter|subscribe|login|signin|sign-in|password/i.test(form)) continue
    if (/<textarea|type=["']?email|name=["'][^"']*(message|inquiry|enquiry|comment)/i.test(form)) return true
  }
  return /hsforms\.com|hubspot\.com\/.*forms|typeform\.com|jotform\.com|docs\.google\.com\/forms|tally\.so|wufoo/i.test(html)
}

function contactLinks(siteUrl: string, html: string): string[] {
  const base = new URL(siteUrl)
  const host = base.hostname.replace(/^www\./, '')
  const out: string[] = []
  for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1]!
    const text = m[2]!.replace(/<[^>]+>/g, ' ')
    if (!CONTACT_LINK_RE.test(href) && !CONTACT_LINK_RE.test(text)) continue
    try {
      const u = new URL(href, base)
      if (u.hostname.replace(/^www\./, '') !== host) continue
      const key = `${u.origin}${u.pathname}`
      if (!out.includes(key)) out.push(key)
    } catch {
      /* not a URL */
    }
  }
  const rank = (u: string) => (/contact|inquir|enquir|問い合わせ|問合せ/i.test(u) ? 0 : 1)
  const guesses = ['/contact', '/contact-us', '/contacts', '/inquiry', '/about', '/company'].map((p) => `${base.origin}${p}`)
  return [...out.sort((a, b) => rank(a) - rank(b)), ...guesses.filter((g) => !out.includes(g))].slice(0, 4)
}

async function precheck(siteUrl: string): Promise<Precheck> {
  const t0 = Date.now()
  const home = await fetchHtml(siteUrl)
  if (!home || home.status >= 400 || home.html.length === 0) return { verdict: 'unreachable', pages: 1, ms: Date.now() - t0, evidence: home ? `status ${home.status}` : 'fetch failed', emails: [] }
  const homeEmails = emailsIn(home.html)
  if (homeEmails.length > 0) return { verdict: 'email', pages: 1, ms: Date.now() - t0, evidence: siteUrl, emails: homeEmails }
  let form = inquiryFormIn(home.html) ? siteUrl : null
  let pages = 1
  for (const link of contactLinks(siteUrl, home.html)) {
    const page = await fetchHtml(link)
    pages++
    if (!page || page.status >= 400) continue
    const emails = emailsIn(page.html)
    if (emails.length > 0) return { verdict: 'email', pages, ms: Date.now() - t0, evidence: link, emails }
    if (form === null && inquiryFormIn(page.html)) form = link
  }
  return form ? { verdict: 'form', pages, ms: Date.now() - t0, evidence: form, emails: [] } : { verdict: 'none', pages, ms: Date.now() - t0, evidence: null, emails: [] }
}

// ---- the full read, as production runs it ---------------------------------

type ReadOutcome = 'email' | 'email_refused' | 'form' | 'form_refused' | 'sns_only' | 'no_contact_found' | 'site_unreadable' | 'read_failed' | 'prereq_uncited' | 'prereq_unverified'

function outcomeOf(e: Awaited<ReturnType<typeof enrichCandidate>>): ReadOutcome {
  if (e.skip) return e.skip
  if (e.email) return e.emailNoSolicitation ? 'email_refused' : 'email'
  if (e.contactFormUrl) return e.formNoSolicitation ? 'form_refused' : 'form'
  if (e.snsAccounts) return 'sns_only'
  return 'no_contact_found'
}

const REGISTERS: ReadOutcome[] = ['email', 'email_refused', 'form', 'form_refused', 'sns_only']

type Row = {
  strategy: string
  name: string
  url: string
  precheck: Precheck
  outcome: ReadOutcome
  email: string | null
  emailOnStaticHtml: boolean | null
  cost: number
}

async function discover(plan: (typeof strategies)[number], count: number): Promise<DiscoverCandidate[]> {
  const today = utcDateKey()
  const search = await callLlmGroundedText(env, 'discover.search', {
    prompt: searchPrompt({ plan: { slug: plan.slug, approach: plan.approach, count }, ...plan.offer, searchNotes: null, learnings: null, targetCountries: [], today }),
  })
  const extracted = await callLlmFollowUpJson(env, 'discover.extract', {
    after: search,
    prompt: extractionPrompt({ search, industries, priorNotes: null, today, strategySlug: plan.slug }),
    schema: extractionSchema,
  })
  return shapeCandidates(extracted.candidates, { slug: plan.slug, count }, industries, search.citations)
}

// A failed attempt is billed too, so the accounting spans both.
async function discoverWithRetry(plan: (typeof strategies)[number], count: number): Promise<{ candidates: DiscoverCandidate[]; cost: number; searches: number }> {
  const before = usages.length
  let candidates: DiscoverCandidate[]
  try {
    candidates = await discover(plan, count)
  } catch (e) {
    if (!(e instanceof LlmError)) throw e
    log(`== ${plan.slug}: ${e.message} — retrying once`)
    candidates = await discover(plan, count)
  }
  const spent = usages.slice(before)
  return { candidates, cost: tokenCost(spent), searches: spent.reduce((a, u) => a + u.searchCalls, 0) }
}

async function measure(plan: (typeof strategies)[number]): Promise<{ rows: Row[]; discoverCost: number; searches: number }> {
  const { candidates, cost: discoverCost, searches } = await discoverWithRetry(plan, countArg)
  const offer = plan.offer.business.split('\n').slice(0, 20).join('\n')
  const rows: Row[] = []
  // Four at a time, as runEnrich does; the scope's jobId attributes each usage line to its candidate.
  for (let i = 0; i < candidates.length; i += 4) {
    const slice = candidates.slice(i, i + 4)
    const results = await Promise.all(
      slice.map(async (c, k) => {
        const key = `${plan.slug}:${i + k}`
        const [pre, enriched] = await Promise.all([
          precheck(c.websiteUrl),
          withLlmScope({ tenantId: 'probe', jobId: key }, () => enrichCandidate(env, c, { procedure, offer, approaches: [plan.approach] })),
        ])
        const cost = tokenCost(usages.filter((u) => u.jobId === key))
        const outcome = outcomeOf(enriched)
        let emailOnStaticHtml: boolean | null = null
        if (enriched.email && enriched.emailSourceUrl) {
          const page = await fetchHtml(enriched.emailSourceUrl)
          emailOnStaticHtml = page !== null && page.html.toLowerCase().includes(enriched.email)
        }
        return { strategy: plan.slug, name: c.name, url: c.websiteUrl, precheck: pre, outcome, email: enriched.email, emailOnStaticHtml, cost } satisfies Row
      }),
    )
    rows.push(...results)
  }
  return { rows, discoverCost, searches }
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(0)}%`
}

function report(all: Row[], discoverCost: number, searches: number): void {
  const n = all.length
  const registered = all.filter((r) => REGISTERS.includes(r.outcome))
  const withEmail = all.filter((r) => r.outcome === 'email')
  const enrichCost = all.reduce((a, r) => a + r.cost, 0)
  const wasted = all.filter((r) => !REGISTERS.includes(r.outcome))
  const wastedCost = wasted.reduce((a, r) => a + r.cost, 0)
  const searchCost = searches * SEARCH_PER_CALL

  log(`\n== all strategies: candidates ${n} | registered ${registered.length} (${pct(registered.length, n)}) | with a usable email ${withEmail.length} (${pct(withEmail.length, n)})`)
  log(`discover token $${discoverCost.toFixed(3)} + search $${searchCost.toFixed(2)} (${searches} calls) | enrich $${enrichCost.toFixed(3)} (${(enrichCost / n).toFixed(4)} / read) | wasted on unregistrable reads $${wastedCost.toFixed(3)} (${pct(wasted.length, n)} of reads, ${pct(wastedCost, enrichCost)} of enrich $)`)
  const perEmail = (c: number) => (withEmail.length === 0 ? '—' : (c / withEmail.length).toFixed(3))
  log(`per prospect with a usable email: enrich $${perEmail(enrichCost)} | discover+search $${perEmail(discoverCost + searchCost)} | total $${perEmail(enrichCost + discoverCost + searchCost)}`)

  log('\n== read outcome by pre-check verdict (rows = pre-check, cols = full read)')
  const outcomes: ReadOutcome[] = ['email', 'email_refused', 'form', 'form_refused', 'sns_only', 'no_contact_found', 'site_unreadable', 'read_failed', 'prereq_uncited', 'prereq_unverified']
  const verdicts: PrecheckVerdict[] = ['email', 'form', 'none', 'unreachable']
  log(`  ${'precheck'.padEnd(12)}${outcomes.map((o) => o.padStart(17)).join('')}   total`)
  for (const v of verdicts) {
    const rows = all.filter((r) => r.precheck.verdict === v)
    log(`  ${v.padEnd(12)}${outcomes.map((o) => String(rows.filter((r) => r.outcome === o).length).padStart(17)).join('')}   ${rows.length}`)
  }

  const skipIf = (pred: (r: Row) => boolean, label: string) => {
    const skipped = all.filter(pred)
    const saved = skipped.reduce((a, r) => a + r.cost, 0)
    const lostReg = skipped.filter((r) => REGISTERS.includes(r.outcome))
    const lostEmail = skipped.filter((r) => r.outcome === 'email')
    const wastedAvoided = skipped.filter((r) => !REGISTERS.includes(r.outcome))
    log(`  ${label}: skips ${skipped.length}/${n} reads, saves $${saved.toFixed(3)} (${pct(saved, enrichCost)} of enrich) | avoids ${wastedAvoided.length}/${wasted.length} wasted reads (${pct(wastedAvoided.length, wasted.length)}) | false negatives: ${lostReg.length} registrable (${pct(lostReg.length, registered.length)}), ${lostEmail.length} with a usable email (${pct(lostEmail.length, withEmail.length)})`)
  }
  log('\n== if enrich skipped a candidate when the pre-check says…')
  skipIf((r) => r.precheck.verdict === 'unreachable', 'unreachable only')
  skipIf((r) => r.precheck.verdict === 'none' || r.precheck.verdict === 'unreachable', 'none or unreachable')

  const emailRows = all.filter((r) => r.email !== null)
  const onHtml = emailRows.filter((r) => r.emailOnStaticHtml === true).length
  const preSeen = emailRows.filter((r) => r.precheck.emails.includes(r.email!)).length
  log(`\n== where the model's email came from: ${emailRows.length} found | present in the static HTML of its source page ${onHtml} | the same address seen by the pre-check ${preSeen}`)
  log(`pre-check: median pages ${median(all.map((r) => r.precheck.pages))}, median ms ${median(all.map((r) => r.precheck.ms))}`)

  log('\n== rows')
  for (const r of all)
    log(
      `  - [${r.strategy}] ${r.name} | ${r.url} | pre=${r.precheck.verdict}(${r.precheck.pages}p${r.precheck.emails.length > 0 ? `: ${r.precheck.emails.slice(0, 2).join(' ')}` : ''}) | read=${r.outcome} | $${r.cost.toFixed(4)}${r.email ? ` | ${r.email}${r.emailOnStaticHtml === false ? ' (not in static HTML)' : ''}` : ''}`,
    )
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!
}

async function main(): Promise<void> {
  const all: Row[] = []
  let discoverCost = 0
  let searches = 0
  for (const plan of strategies) {
    if (only && plan.slug !== only) continue
    const t0 = Date.now()
    const m = await measure(plan)
    all.push(...m.rows)
    discoverCost += m.discoverCost
    searches += m.searches
    log(`== ${plan.slug}: ${m.rows.length} candidates, ${Math.round((Date.now() - t0) / 1000)} s`)
  }
  report(all, discoverCost, searches)
  if (outPath) writeFileSync(outPath, JSON.stringify({ date: utcDateKey(), count: countArg, discoverCost, searches, rows: all }, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
