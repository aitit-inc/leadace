/**
 * The yardstick for a change to hosted discover: the production search,
 * extraction and enrichCandidate on two fixed strategies, printing what such
 * a change must not make worse — candidates, those with a contact channel,
 * those that also keep a confirmed signal, resolvable URLs, queries, cost.
 * Same input every run, so before / after are comparable.
 *
 * Usage (from backend/, OPENAI_API_KEY in .dev.vars):
 *   npx tsx scripts/probe-discover.ts [strategy-slug]
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { extractionPrompt, extractionSchema, searchPrompt, shapeCandidates } from '../src/services/pipeline/discover'
import { enrichCandidate } from '../src/services/pipeline/enrich'
import { callLlmFollowUpJson, callLlmGroundedText, LlmError } from '../src/services/llm'
import { parseIndustryVocabulary, type HostedEnv } from '../src/services/pipeline/context'
import { utcDateKey } from '../src/domain/time'

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

const business = `# Business & Service Information
## Organization Overview
SurpassOne Inc. (Tokyo, founded 2023). Builds LeadAce.
## Service / Product Overview
LeadAce is an autonomous outbound sales agent for small B2B teams: it finds prospect organizations from registered discovery strategies, reads their websites for a contact and recent activity, writes a personalised first email grounded in what the site says, sends from the team's Gmail, and tracks replies.
## Features & Strengths
Every claim in an email is grounded in the prospect's own site; runs unattended on a schedule; built-in compliance (unsubscribe, do-not-contact, no-solicitation detection).
## Pricing
Free (30 prospects, lifetime), Starter $49/month for 100 prospects, Pro $99/month for 300.`

const salesStrategy = `# Sales Strategy
## Target
Small B2B companies (10–50 people) that sell to other businesses and rely on outbound to grow: SaaS startups after a seed or Series A round, boutique agencies and consultancies, IT service firms. Decision maker: founder / CEO / head of sales.
## Prerequisites (observable)
- Has a product or service sold B2B with a public website in Japanese or English
- Evidence of outbound or sales capacity building: a sales / SDR / BDR job post, a recent funding round, a new sales lead hire, or a stated expansion
## Not a fit
Consumer brands, enterprises over 500 people, agencies that sell outbound services themselves (competitors), recruiting firms.
## Search Keywords
シード 資金調達 SaaS / シリーズA 資金調達 BtoB / インサイドセールス 募集 スタートアップ / seed round B2B SaaS / hiring SDR startup / boutique agency B2B`

const strategies = [
  {
    slug: 'jp-funded-saas',
    approach:
      'Japanese B2B SaaS startups that announced a seed or Series A round in the last 90 days. Sources: PR TIMES (prtimes.jp) funding releases, INITIAL / STARTUP DB news, 日本経済新聞 スタートアップ, TechCrunch Japan / BRIDGE. Verify each on its official site.',
    count: 8,
  },
  {
    slug: 'us-boutique-agencies',
    approach:
      'US boutique B2B agencies and consultancies (10–50 people) with a public case-study page and an open sales / business-development role. Sources: Clutch and DesignRush directories, agency job posts on LinkedIn / Wellfound, "we are hiring" pages.',
    count: 8,
  },
]
const industries = parseIndustryVocabulary(readFileSync(resolve(__dirname, '../seed-content/tpl_industries.md'), 'utf8'))
const procedure = readFileSync(resolve(__dirname, '../seed-content/tpl_enrich_contacts.md'), 'utf8')
const offer = business.split('\n').slice(0, 20).join('\n')

type Usage = { op: string; model: string; input: number; cachedInput: number; toolInput: number; output: number; thoughts: number; tier: string; searchCalls: number }
const usages: Usage[] = []
const log = console.log
console.log = (o: unknown) => {
  if (o && typeof o === 'object' && 'op' in o) usages.push(o as Usage)
}
// 2026 list prices per MTok by model; the flex tier is billed at half.
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, cached: 0.075, output: 3.75 },
  'gemini-3.1-flash-lite': { input: 0.1, cached: 0.01, output: 0.4 },
  'gpt-5.6-luna': { input: 0.2, cached: 0.02, output: 1.2 },
  'gpt-5.6-terra': { input: 2, cached: 0.2, output: 12 },
}
const tokenCost = (u: Usage[]) =>
  u.reduce((a, x) => {
    const p = PRICES[x.model]
    if (!p) throw new Error(`no price for ${x.model}`)
    return a + (((x.input + x.toolInput - x.cachedInput) * p.input + x.cachedInput * p.cached + (x.output + x.thoughts) * p.output) / 1e6) * (x.tier === 'flex' ? 0.5 : 1)
  }, 0)
// Web search bills per call.
const SEARCH_PER_CALL = 0.01

async function resolves(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12_000), headers: { 'user-agent': 'Mozilla/5.0' } })
    await res.body?.cancel()
    return res.status < 400
  } catch {
    return false
  }
}

async function measure(plan: (typeof strategies)[number]): Promise<void> {
  const today = utcDateKey()
  const t0 = Date.now()
  const before = usages.length
  const search = await callLlmGroundedText(env, 'discover.search', {
    prompt: searchPrompt({ plan, business, salesStrategy, searchNotes: null, learnings: null, targetCountries: [], today }),
  })
  const extracted = await callLlmFollowUpJson(env, 'discover.extract', {
    after: search,
    prompt: extractionPrompt({ search, industries, priorNotes: null, today, strategySlug: plan.slug }),
    schema: extractionSchema,
  })
  const candidates = shapeCandidates(extracted.candidates, plan, industries, search.citations)
  const discoverCost = tokenCost(usages.slice(before))
  const searches = usages.slice(before).reduce((a, u) => a + u.searchCalls, 0)
  const discoverMs = Date.now() - t0

  // Four at a time, as runEnrich does.
  const enriched: Awaited<ReturnType<typeof enrichCandidate>>[] = []
  for (let i = 0; i < candidates.length; i += 4) {
    enriched.push(...(await Promise.all(candidates.slice(i, i + 4).map((c) => enrichCandidate(env, c, { procedure, offer, approaches: [plan.approach] })))))
  }
  const enrichCost = tokenCost(usages.slice(before)) - discoverCost
  const resolved = await Promise.all(candidates.map((c) => resolves(c.websiteUrl)))
  const channel = (e: (typeof enriched)[number]) => e.email ?? e.contactFormUrl ?? (e.snsAccounts ? 'sns' : null)

  log(`\n== ${plan.slug} (${today})`)
  log(`candidates ${candidates.length} | with a claimed signal ${candidates.filter((c) => c.signals.length > 0).length} | with a contact channel ${enriched.filter((e) => channel(e) !== null).length} | with a channel and a confirmed signal ${enriched.filter((e) => channel(e) !== null && e.signals.length > 0).length} | no-solicitation ${enriched.filter((e) => e.noSolicitation).length} | official URL resolves ${resolved.filter(Boolean).length}/${candidates.length}`)
  log(`search calls ${searches} | token $ (billed tier) discover ${discoverCost.toFixed(3)} + enrich ${enrichCost.toFixed(3)} | search $ ${(searches * SEARCH_PER_CALL).toFixed(2)} | discover ${discoverMs} ms, total ${Date.now() - t0} ms`)
  for (const [i, c] of candidates.entries()) {
    const e = enriched[i]!
    log(`  - ${c.name} | ${c.websiteUrl} | ${resolved[i] ? 'ok' : 'unresolved'} | ${channel(e) ?? e.notes ?? 'no channel'} | signals ${c.signals.length} → ${e.signals.length}${e.signals[0] ? ` | ${e.signals[0].slice(0, 90)}` : ''}`)
  }
}

// One retry per strategy, as the Workflow step has.
async function measureWithRetry(plan: (typeof strategies)[number]): Promise<void> {
  try {
    await measure(plan)
  } catch (e) {
    if (!(e instanceof LlmError)) throw e
    log(`\n== ${plan.slug}: ${e.message} — retrying once`)
    await measure(plan)
  }
}

async function main(): Promise<void> {
  const only = process.argv[2]
  for (const plan of strategies) if (!only || plan.slug === only) await measureWithRetry(plan)
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error(e)
    process.exit(1)
  })
