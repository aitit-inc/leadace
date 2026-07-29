/**
 * Source-driven discovery spike: do high-yield, delta-detectable signal sources
 * exist for LeadAce's own ICP?
 *
 * The watch-tower design (signal_acquisition_design.local.md D1) polls a list of
 * companies and asks each whether anything happened. This probes the inverse:
 * read the places where events get published, and let the event produce the
 * company. Cost then scales with the number of sources, not the population, and
 * every hit arrives already dated, attributed and sourced.
 *
 * Per source it reports the three things that decide whether the inversion is
 * buildable at all:
 *   delta   — how you ask for only what is new (native filter beats diffing)
 *   yield   — entries in the window, i.e. is there enough supply
 *   contact — how far an entry gets you toward a reachable prospect
 *
 * ICP is competitive_strategy.md A3.4 層 1: solo founders and contract engineers
 * building with AI agents, whose named touchpoints are GitHub, HN, X, Indie
 * Hackers and the Claude Code marketplace.
 *
 * Counting only. Addresses seen here are publicly posted, and harvesting them
 * for outreach is gated on the published-address rules build-list already
 * spells out — this script neither stores nor sends anything.
 *
 * Unauthenticated GitHub allows 10 search req/min and 60 core req/hour, which
 * is what caps --sample. Set GITHUB_TOKEN to lift it.
 *
 * Usage:
 *   npx tsx scripts/probe-signal-sources.ts
 *   npx tsx scripts/probe-signal-sources.ts --days=7 --sample=30
 */

import { z } from 'zod'

const USER_AGENT = 'LeadAceBot/1.0 (+https://leadace.ai)'
const DAY_MS = 86_400_000

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

const githubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
  }
  const token = process.env['GITHUB_TOKEN']
  if (token !== undefined && token !== '') headers['authorization'] = `Bearer ${token}`
  return headers
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.json()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const apexOf = (raw: string): string | null => {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host.startsWith('www.') ? host.slice(4) : host
  } catch {
    return null
  }
}

/** Sources whose entries are consumer platforms, not the company behind them. */
const NOT_A_COMPANY = new Set([
  'github.com',
  'gitlab.com',
  'x.com',
  'twitter.com',
  'youtube.com',
  'youtu.be',
  'medium.com',
  'substack.com',
  'reddit.com',
  'news.ycombinator.com',
  'notion.site',
  'docs.google.com',
  'arxiv.org',
  'huggingface.co',
  'npmjs.com',
  'pypi.org',
])

type SourceReport = {
  source: string
  delta: string
  windowDays: number
  yield: number | 'unbounded'
  sampled: number
  withOwnDomain: number
  withPublicEmail: number | null
  /** Non-noreply address in the commit log — the address the classic tactic uses. */
  withCommitEmail: number | null
  commitsChecked: number
  notes: string[]
}

const repoSchema = z.object({
  total_count: z.number(),
  items: z.array(
    z.object({
      full_name: z.string(),
      html_url: z.string(),
      homepage: z.string().nullable(),
      stargazers_count: z.number(),
      owner: z.object({ login: z.string(), type: z.string() }),
    }),
  ),
})

const userSchema = z.object({
  login: z.string(),
  type: z.string(),
  email: z.string().nullable(),
  blog: z.string().nullable(),
  company: z.string().nullable(),
})

const commitsSchema = z.array(
  z.object({ commit: z.object({ author: z.object({ email: z.string().nullish() }) }) }),
)

const isNoreply = (email: string): boolean => email.endsWith('users.noreply.github.com')

async function probeGithub(
  days: number,
  sample: number,
  query: string,
  coreBudget: number,
): Promise<SourceReport> {
  const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
  const url =
    `https://api.github.com/search/repositories?q=${encodeURIComponent(`${query} created:>${since}`)}` +
    `&sort=stars&order=desc&per_page=${Math.min(sample, 100)}`
  const found = repoSchema.parse(await getJson(url, githubHeaders()))

  const notes: string[] = []
  let withOwnDomain = 0
  let withEmail = 0
  let withCommitEmail = 0
  let noreplyOnly = 0
  const seenOwners = new Set<string>()
  let orgOwned = 0
  let profilesChecked = 0
  let commitsChecked = 0
  // Split what the unauthenticated core limit allows between the two questions:
  // does the profile publish an address, and does the commit log leak one.
  let budget = coreBudget
  const half = Math.floor(coreBudget / 2)

  const repos = found.items.slice(0, sample)
  for (const repo of repos) {
    if (repo.homepage !== null && repo.homepage !== '') {
      const apex = apexOf(repo.homepage.startsWith('http') ? repo.homepage : `https://${repo.homepage}`)
      if (apex !== null && !NOT_A_COMPANY.has(apex)) withOwnDomain++
    }
    if (repo.owner.type === 'Organization') orgOwned++
    if (seenOwners.has(repo.owner.login) || profilesChecked >= half || budget <= 0) continue
    seenOwners.add(repo.owner.login)
    profilesChecked++
    budget--
    try {
      const user = userSchema.parse(
        await getJson(`https://api.github.com/users/${repo.owner.login}`, githubHeaders()),
      )
      if (user.email !== null && user.email !== '') withEmail++
      await sleep(1200)
    } catch (e) {
      notes.push(`profile lookup stopped: ${e instanceof Error ? e.message : 'error'}`)
      break
    }
  }

  for (const repo of repos) {
    if (budget <= 0) break
    budget--
    commitsChecked++
    try {
      const commits = commitsSchema.parse(
        await getJson(
          `https://api.github.com/repos/${repo.full_name}/commits?per_page=20`,
          githubHeaders(),
        ),
      )
      const addresses = commits
        .map((c) => c.commit.author.email)
        .filter((e): e is string => e !== null && e !== undefined && e !== '')
      if (addresses.some((e) => !isNoreply(e))) withCommitEmail++
      else if (addresses.length > 0) noreplyOnly++
      await sleep(1200)
    } catch (e) {
      notes.push(`commit lookup stopped: ${e instanceof Error ? e.message : 'error'}`)
      commitsChecked--
      break
    }
  }

  notes.push(`query: ${query}`)
  notes.push(`owner is an Organization: ${orgOwned}/${repos.length}`)
  notes.push(`profiles fetched: ${profilesChecked} (distinct owners ${seenOwners.size})`)
  notes.push(`commit logs carrying only *.users.noreply.github.com: ${noreplyOnly}/${commitsChecked}`)
  return {
    source: `github-new-repos`,
    delta: 'native: search qualifier created:>DATE (also pushed:>DATE)',
    windowDays: days,
    yield: found.total_count,
    sampled: repos.length,
    withOwnDomain,
    withPublicEmail: withEmail,
    withCommitEmail,
    commitsChecked,
    notes,
  }
}

const hnSchema = z.object({
  nbHits: z.number(),
  // Ask-HN-shaped submissions carry no url at all, so the field can be absent
  // as well as null.
  hits: z.array(z.object({ title: z.string().nullish(), url: z.string().nullish() })),
})

async function probeHackerNews(days: number, sample: number): Promise<SourceReport> {
  const since = Math.floor((Date.now() - days * DAY_MS) / 1000)
  const url =
    `https://hn.algolia.com/api/v1/search_by_date?tags=show_hn` +
    `&numericFilters=${encodeURIComponent(`created_at_i>${since}`)}&hitsPerPage=${Math.min(sample, 100)}`
  const found = hnSchema.parse(await getJson(url, { 'user-agent': USER_AGENT }))

  let withOwnDomain = 0
  for (const hit of found.hits) {
    if (hit.url === null || hit.url === undefined) continue
    const apex = apexOf(hit.url)
    if (apex !== null && !NOT_A_COMPANY.has(apex)) withOwnDomain++
  }
  return {
    source: 'hn-show-hn',
    delta: 'native: Algolia numericFilters created_at_i>UNIXTIME',
    windowDays: days,
    yield: found.nbHits,
    sampled: found.hits.length,
    withOwnDomain,
    withPublicEmail: null,
    withCommitEmail: null,
    commitsChecked: 0,
    notes: ['no auth, no rate limit hit', 'submitted URL is the product/company site'],
  }
}

const ycSchema = z.array(
  z.object({
    name: z.string(),
    website: z.string().nullable(),
    batch: z.string().nullable(),
    launched_at: z.number().nullable(),
  }),
)

async function probeYcombinator(days: number, sample: number): Promise<SourceReport> {
  const all = ycSchema.parse(
    await getJson('https://yc-oss.github.io/api/companies/all.json', { 'user-agent': USER_AGENT }),
  )
  const since = Math.floor((Date.now() - days * DAY_MS) / 1000)
  const recent = all.filter((c) => c.launched_at !== null && c.launched_at >= since)
  const withSite = all.filter((c) => c.website !== null && c.website !== '').length
  const batches = new Set(all.map((c) => c.batch).filter((b): b is string => b !== null))
  return {
    source: 'yc-directory',
    delta: 'none native: full dump, diff against the previous snapshot',
    windowDays: days,
    yield: recent.length,
    sampled: Math.min(all.length, sample),
    withOwnDomain: Math.round((withSite / all.length) * Math.min(all.length, sample)),
    withPublicEmail: null,
    withCommitEmail: null,
    commitsChecked: 0,
    notes: [
      `full directory: ${all.length} companies across ${batches.size} batches`,
      `carry a website: ${withSite} (${((withSite / all.length) * 100).toFixed(1)}%)`,
      'batches land ~2x/year — high quality, low frequency',
    ],
  }
}

function render(reports: readonly SourceReport[]): void {
  for (const r of reports) {
    const pct = (n: number) => (r.sampled === 0 ? '—' : `${((n / r.sampled) * 100).toFixed(0)}%`)
    console.log(`\n── ${r.source}`)
    console.log(`   delta   ${r.delta}`)
    console.log(
      `   yield   ${r.yield} entries in ${r.windowDays}d` +
        (typeof r.yield === 'number' ? ` (~${Math.round(r.yield / r.windowDays)}/day)` : ''),
    )
    console.log(`   sample  n=${r.sampled}`)
    console.log(`   └ entry points at its own domain   ${r.withOwnDomain}  ${pct(r.withOwnDomain)}`)
    if (r.withPublicEmail !== null) {
      console.log(`   └ owner publishes an email         ${r.withPublicEmail}  ${pct(r.withPublicEmail)}`)
    }
    if (r.withCommitEmail !== null && r.commitsChecked > 0) {
      const cp = `${((r.withCommitEmail / r.commitsChecked) * 100).toFixed(0)}%`
      console.log(`   └ real address in the commit log   ${r.withCommitEmail}/${r.commitsChecked}  ${cp}`)
    }
    for (const note of r.notes) console.log(`   · ${note}`)
  }
}

async function main(): Promise<void> {
  const days = numFlag('days', 7)
  const sample = numFlag('sample', 30)
  const query = flag('query') ?? 'mcp OR "claude code" OR "ai agent"'
  const coreBudget = numFlag('core-budget', 40)

  console.log(`probing signal sources — window ${days}d, sample ${sample}`)
  if (process.env['GITHUB_TOKEN'] === undefined) {
    console.log('(no GITHUB_TOKEN: 60 core req/hour, owner sampling will be shallow)')
  }

  const reports: SourceReport[] = []
  for (const probe of [
    () => probeHackerNews(days, sample),
    () => probeYcombinator(days, sample),
    () => probeGithub(days, sample, query, coreBudget),
  ]) {
    try {
      reports.push(await probe())
    } catch (e) {
      console.error(`  probe failed: ${e instanceof Error ? e.message : 'error'}`)
    }
  }
  render(reports)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
