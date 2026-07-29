/**
 * Can a source be assessed mechanically, or does reading it need a model?
 *
 * probe-signal-sources.ts answers "is this particular source any good", one
 * hand-written probe per API. That does not generalise: the premise of
 * source-driven discovery (source_driven_discovery.local.md) is that an agent
 * meets sources it has never seen, for a target nobody anticipated. So this
 * asks the prior question — given only a URL, how much can be established
 * without understanding the page?
 *
 * Per URL it reports the mechanical facts that decide how a collector would be
 * built: whether the page announces a feed, whether conditional GET works,
 * whether it carries dated entries at all (Gregorian, 年月日, or 令和), and how
 * list-shaped it is. What it deliberately does not try is to extract the
 * entries — that is where page shapes explode and a model earns its keep
 * (memo ㊴).
 *
 * Usage:
 *   npx tsx scripts/probe-source-shape.ts <url> [<url> …]
 *   npx tsx scripts/probe-source-shape.ts --file=urls.txt
 */

import { readFileSync } from 'node:fs'

const USER_AGENT = 'LeadAceBot/1.0 (+https://leadace.ai)'
const TIMEOUT_MS = 20_000

const FEED_LINK = /<link\b[^>]*type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi
const HREF = /href=["']([^"']+)["']/i

// A listing worth watching announces when each entry appeared. Three notations
// cover the targets in play; 令和 matters because Japanese public bodies date
// procurement notices in the imperial era and nothing else on the page does.
const DATE_PATTERNS: readonly { name: string; re: RegExp }[] = [
  { name: 'iso', re: /\b20\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/g },
  { name: 'ja', re: /20\d{2}\s*年\s*(?:0?[1-9]|1[0-2])\s*月\s*(?:0?[1-9]|[12]\d|3[01])\s*日/g },
  { name: 'reiwa', re: /令和\s*(?:元|\d{1,2})\s*年\s*(?:0?[1-9]|1[0-2])\s*月/g },
]

type Shape = {
  url: string
  status: number | null
  error: string | null
  contentType: string | null
  chars: number
  feeds: string[]
  etag: boolean
  lastModified: boolean
  notModified: boolean | null
  dates: Record<string, number>
  listItems: number
  tableRows: number
  links: number
}

const countOf = (haystack: string, re: RegExp): number => {
  const matches = haystack.match(re)
  return matches === null ? 0 : matches.length
}

async function probe(url: string): Promise<Shape> {
  const base: Shape = {
    url,
    status: null,
    error: null,
    contentType: null,
    chars: 0,
    feeds: [],
    etag: false,
    lastModified: false,
    notModified: null,
    dates: {},
    listItems: 0,
    tableRows: 0,
    links: 0,
  }
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.name : 'fetch_failed' }
  }
  if (!res.ok) {
    await res.body?.cancel()
    return { ...base, status: res.status, error: `http_${res.status}` }
  }

  const etag = res.headers.get('etag')
  const lastModified = res.headers.get('last-modified')
  const contentType = res.headers.get('content-type')
  const body = await res.text()

  const feeds = [...body.matchAll(FEED_LINK)]
    .map((m) => HREF.exec(m[0])?.[1])
    .filter((h): h is string => h !== undefined)
    .map((h) => {
      try {
        return new URL(h, res.url).toString()
      } catch {
        return h
      }
    })

  const dates: Record<string, number> = {}
  for (const { name, re } of DATE_PATTERNS) {
    const n = countOf(body, re)
    if (n > 0) dates[name] = n
  }

  let notModified: boolean | null = null
  if (etag !== null || lastModified !== null) {
    const headers: Record<string, string> = { 'user-agent': USER_AGENT }
    if (etag !== null) headers['if-none-match'] = etag
    if (lastModified !== null) headers['if-modified-since'] = lastModified
    try {
      // The validators came from res.url, so the pre-redirect URL may answer
      // for a different resource — or never 304 at all.
      const again = await fetch(res.url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      notModified = again.status === 304
      await again.body?.cancel()
    } catch {
      notModified = null
    }
  }

  return {
    url: res.url,
    status: res.status,
    error: null,
    contentType,
    chars: body.length,
    feeds: [...new Set(feeds)],
    etag: etag !== null,
    lastModified: lastModified !== null,
    notModified,
    dates,
    listItems: countOf(body, /<li\b/gi),
    tableRows: countOf(body, /<tr\b/gi),
    links: countOf(body, /<a\b[^>]*href=/gi),
  }
}

/**
 * Not a verdict on the source, only on how it can be read: whether a collector
 * gets a cheap delta, and whether the page even looks like a dated list.
 */
function verdict(s: Shape): string {
  if (s.error !== null) return `unreachable (${s.error})`
  const totalDates = Object.values(s.dates).reduce((a, b) => a + b, 0)
  const listish = s.listItems + s.tableRows
  const delta =
    s.feeds.length > 0
      ? 'feed'
      : s.notModified === true
        ? 'conditional GET'
        : s.etag || s.lastModified
          ? 'validator offered but not honoured'
          : 'diff the page'
  const dated = totalDates === 0 ? 'no dates on the page' : `${totalDates} dates`
  const shape = listish >= 20 ? `list-shaped (${listish} rows)` : `not list-shaped (${listish})`
  return `${delta} · ${dated} · ${shape}`
}

async function main(): Promise<void> {
  const fileFlag = process.argv.slice(2).find((a) => a.startsWith('--file='))
  const urls =
    fileFlag === undefined
      ? process.argv.slice(2).filter((a) => !a.startsWith('--'))
      : readFileSync(fileFlag.slice('--file='.length), 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'))

  if (urls.length === 0) {
    console.error('give at least one URL, or --file=urls.txt')
    process.exit(1)
  }

  for (const url of urls) {
    const shape = await probe(url)
    console.log(`\n${shape.url}`)
    console.log(`  ${verdict(shape)}`)
    if (shape.error === null) {
      const validators = [shape.etag ? 'ETag' : null, shape.lastModified ? 'Last-Modified' : null]
        .filter((v) => v !== null)
        .join(' + ')
      console.log(
        `  ${shape.chars} chars · ${validators === '' ? 'no validators' : validators}` +
          `${shape.notModified === true ? ' → 304' : shape.notModified === false ? ' → 200' : ''}` +
          ` · ${shape.links} links`,
      )
      if (Object.keys(shape.dates).length > 0) {
        console.log(`  dates: ${Object.entries(shape.dates).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      }
      for (const feed of shape.feeds) console.log(`  feed: ${feed}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
