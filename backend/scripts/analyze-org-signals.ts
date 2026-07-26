/**
 * Read-only health check on org-signals acquisition.
 *
 * Usage:
 *   npx tsx scripts/analyze-org-signals.ts --env-file=.env.production
 *   npx tsx scripts/analyze-org-signals.ts --env-file=.env.production --probe=100
 *
 * Reads org_signals_global and organizations. Writes nothing, ever.
 *
 * The refresh path stores only the latest attempt, which is enough: a row whose
 * signals_updated_at trails last_attempt_at means that attempt saved nothing.
 * What the table cannot say is *why* — so --probe re-runs the URL-selection step
 * (deterministic, fetch-only, no LLM, no cost) against live sites to split yield
 * by URL source. That split was 37% vs 10% when measured on 2026-07-26, and it
 * is the axis worth watching.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'
import {
  orderByEventPreference,
  parseRobotsSitemaps,
  parseSitemap,
  preferEventSitemap,
  selectSignalUrls,
  isSameSite,
  type SitemapEntry,
} from '../src/domain/sitemap'
import { isPublicWebUrl } from '../src/domain/url'
import { HIGHLIGHT_MAX_AGE_DAYS } from '../src/domain/org-signals'
import type { OrgSignals } from '../src/db/schema'

const __dirname =
  typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const envFileArg = args.find((a) => a.startsWith('--env-file='))
if (envFileArg) {
  const envPath = resolve(__dirname, '..', envFileArg.slice('--env-file='.length))
  if (!existsSync(envPath)) {
    console.error(`env file not found: ${envPath}`)
    process.exit(1)
  }
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    let value = m[2]!
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[m[1]!] === undefined) process.env[m[1]!] = value
  }
}
if (!process.env['DATABASE_URL']) {
  const devVarsPath = resolve(__dirname, '..', '.dev.vars')
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, 'utf-8').split('\n')) {
      const m = line.match(/^DATABASE_URL\s*=\s*"?([^"\n]+?)"?\s*$/)
      if (m) {
        process.env['DATABASE_URL'] = m[1]
        break
      }
    }
  }
}
const probeArg = args.find((a) => a.startsWith('--probe='))
const probeCount = probeArg === undefined ? 0 : Number(probeArg.slice('--probe='.length))

const DAY_MS = 86_400_000
const now = Date.now()
const pct = (n: number, d: number) => (d === 0 ? '   -' : `${((100 * n) / d).toFixed(0)}%`.padStart(4))
const line = (label: string, n: number, d: number) =>
  `  ${label.padEnd(36)}${String(n).padStart(6)}  ${pct(n, d)}`

type SignalRow = {
  domain: string
  signals: OrgSignals | null
  signals_updated_at: Date | null
  last_attempt_at: Date
}

async function main() {
  const databaseUrl = process.env['DATABASE_URL']
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is required (env, --env-file=<path>, or backend/.dev.vars)')
  }
  const sql = postgres(databaseUrl, { prepare: false, max: 4 })
  try {
    const rows = (await sql`
      SELECT domain, signals, signals_updated_at, last_attempt_at
      FROM org_signals_global
    `) as unknown as SignalRow[]
    const [orgs] = (await sql`
      SELECT COUNT(DISTINCT domain)::int AS n FROM organizations
    `) as unknown as [{ n: number }]

    report(rows, orgs.n)
    if (probeCount > 0) await reportSources(rows)
  } finally {
    await sql.end()
  }
}

function report(rows: readonly SignalRow[], orgDomains: number): void {
  const total = rows.length
  console.log(`\n=== org-signals 健康診断 (${new Date().toISOString().slice(0, 10)}) ===\n`)
  console.log(`  organizations の実ドメイン数        ${String(orgDomains).padStart(6)}`)
  console.log(`  org_signals_global の行数           ${String(total).padStart(6)}`)
  if (total === 0) {
    console.log('\n  行がありません。cron が一度も走っていない可能性があります。')
    return
  }

  console.log(`\n直近の試行`)
  console.log(line('最後の試行で保存できた', savedOnLastAttempt(rows).length, total))
  console.log(line('最後の試行は空振り', total - savedOnLastAttempt(rows).length, total))
  console.log(line('一度も保存できたことがない', rows.filter((r) => r.signals_updated_at === null).length, total))

  const held = rows.filter(
    (r): r is SignalRow & { signals: OrgSignals; signals_updated_at: Date } =>
      r.signals !== null && r.signals_updated_at !== null,
  )
  console.log(`\n保持している payload の鮮度  (n=${held.length})`)
  for (const [label, max] of [
    ['7 日以内', 7],
    ['14 日以内 (hasFreshSignal の窓)', 14],
    ['30 日以内', 30],
  ] as const) {
    console.log(line(label, held.filter((r) => ageDays(r.signals_updated_at) <= max).length, held.length))
  }
  console.log(
    line('それより古い (参照されない)', held.filter((r) => ageDays(r.signals_updated_at) > 14).length, held.length),
  )

  const has = (f: (s: OrgSignals) => boolean) => held.filter((r) => f(r.signals)).length
  console.log(`\n中身の内訳  (n=${held.length})`)
  console.log(line('highlights あり', has((s) => (s.highlights?.length ?? 0) > 0), held.length))
  console.log(line('pressReleases あり', has((s) => (s.pressReleases?.length ?? 0) > 0), held.length))
  console.log(line('funding あり', has((s) => s.funding !== undefined), held.length))
  console.log(line('hiring あり', has((s) => s.hiring !== undefined), held.length))
  console.log(line('leadership あり', has((s) => (s.leadership?.length ?? 0) > 0), held.length))
  console.log(
    line(
      'イベント無し (hiring/leadership のみ)',
      has((s) => (s.highlights?.length ?? 0) === 0 && (s.pressReleases?.length ?? 0) === 0 && s.funding === undefined),
      held.length,
    ),
  )

  // Every event stored by the current write path passed the window check, so one
  // outside it was either written before that check existed or the check is not
  // holding — the newest offending row's date is what tells the two apart.
  const dated = held.flatMap((r) =>
    eventAgeDays(r.signals, r.signals_updated_at).map((age) => ({ age, storedAt: r.signals_updated_at })),
  )
  if (dated.length > 0) {
    const sorted = [...dated].map((d) => d.age).sort((a, b) => a - b)
    const at = (q: number) => Math.round(sorted[Math.floor(q * (sorted.length - 1))]!)
    console.log(`\n引用イベントの古さ  (保存時点から遡って何日前か・n=${sorted.length})`)
    console.log(`  中央値 ${at(0.5)} 日 / 90 パーセンタイル ${at(0.9)} 日 / 最古 ${at(1)} 日`)
    const outside = dated.filter((d) => d.age > HIGHLIGHT_MAX_AGE_DAYS || d.age < 0)
    if (outside.length === 0) {
      console.log(`  ✅ 全件が ${HIGHLIGHT_MAX_AGE_DAYS} 日窓の内側`)
    } else {
      const newest = new Date(Math.max(...outside.map((d) => d.storedAt.getTime())))
      console.log(`  ⚠ ${outside.length} 件が ${HIGHLIGHT_MAX_AGE_DAYS} 日窓の外`)
      console.log(`     該当行の最新保存日 ${newest.toISOString().slice(0, 10)}`)
      console.log(`     窓チェック導入より前ならレガシー、後なら書き込み経路のバグ`)
    }
  }

  const stuck = rows
    .filter((r) => r.signals_updated_at === null && ageDays(r.last_attempt_at) < 14)
    .slice(0, 15)
  if (stuck.length > 0) {
    console.log(`\n一度も保存できていないドメイン (直近も試行済み・先頭 ${stuck.length} 件)`)
    for (const r of stuck) console.log(`  ${r.domain}`)
  }
  console.log()
}

async function reportSources(rows: readonly SignalRow[]): Promise<void> {
  console.log(`URL 源の再判定  (--probe=${probeCount}・取得のみ / LLM なし / 費用ゼロ)`)
  const sample = rows.slice(0, probeCount)
  const sources = await probeSources(sample.map((r) => r.domain))
  const saved = new Set(savedOnLastAttempt(rows).map((r) => r.domain))
  for (const source of ['sitemap', 'fallback-home', 'none'] as const) {
    const group = sample.filter((r) => sources.get(r.domain) === source)
    if (group.length === 0) continue
    const hit = group.filter((r) => saved.has(r.domain)).length
    console.log(
      `  ${source.padEnd(16)} n=${String(group.length).padStart(4)}  最後の試行で保存 ${String(hit).padStart(4)}  ${pct(hit, group.length)}`,
    )
  }
  console.log(`  ※ 現時点の URL 源 × 直近試行の成否。sitemap 側が落ちてきたら取得層の劣化を疑う\n`)
}

// signals_updated_at is written only together with signals, so it equals
// last_attempt_at exactly when that attempt saved something.
function savedOnLastAttempt(rows: readonly SignalRow[]): SignalRow[] {
  return rows.filter(
    (r) => r.signals_updated_at !== null && r.signals_updated_at.getTime() === r.last_attempt_at.getTime(),
  )
}

function ageDays(d: Date): number {
  return (now - d.getTime()) / DAY_MS
}

const ISO_DATE = /\d{4}-\d{2}-\d{2}/g

function eventAgeDays(s: OrgSignals, storedAt: Date): number[] {
  const texts = [
    ...(s.highlights ?? []),
    ...(s.pressReleases ?? []).map((p) => p.publishedAt ?? ''),
    s.funding?.announcedAt ?? '',
  ]
  return texts.flatMap((t) => {
    const dates = [...t.matchAll(ISO_DATE)].map(([iso]) => Date.parse(iso)).filter((d) => !Number.isNaN(d))
    return dates.length === 0 ? [] : [(storedAt.getTime() - Math.max(...dates)) / DAY_MS]
  })
}

// Mirrors resolveSignalUrls in services/org-signals.ts. Kept as a copy so an
// analysis tool does not widen the service's exported surface; if the two drift,
// the probe reports a stale split and nothing in the request path changes.
async function probeSources(domains: readonly string[]): Promise<Map<string, string>> {
  const FETCH_TIMEOUT_MS = 8000
  const MAX_SITEMAP_BYTES = 512 * 1024
  const UA = 'LeadAceBot/1.0 (+https://leadace.ai)'

  const fetchText = async (url: string, maxBytes: number): Promise<string | null> => {
    if (!isPublicWebUrl(url)) return null
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        redirect: 'follow',
        headers: { 'user-agent': UA },
      })
      if (!res.ok) return null
      return (await res.text()).slice(0, maxBytes)
    } catch {
      return null
    }
  }
  const fetchSitemap = async (url: string) => {
    const body = await fetchText(url, MAX_SITEMAP_BYTES)
    return body === null ? null : parseSitemap(body)
  }

  const sourceOf = async (domain: string): Promise<string> => {
    const robots = await fetchText(`https://${domain}/robots.txt`, 32 * 1024)
    const declared = robots === null ? [] : parseRobotsSitemaps(robots).filter((u) => isSameSite(u, domain))
    const candidates = orderByEventPreference([
      ...new Set([...declared, `https://${domain}/sitemap.xml`, `https://www.${domain}/sitemap.xml`]),
    ])
    let remaining = 2
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
      if (selectSignalUrls(entries, domain, 3).length > 0) return 'sitemap'
    }
    return isPublicWebUrl(`https://${domain}/`) ? 'fallback-home' : 'none'
  }

  const out = new Map<string, string>()
  const queue = [...domains]
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let d = queue.shift(); d !== undefined; d = queue.shift()) {
        out.set(d, await sourceOf(d))
      }
    }),
  )
  return out
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
