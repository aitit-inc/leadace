import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

export const DATA = resolve(__dirname, 'data.local')

export const specSchema = z.object({
  slug: z.string().min(1),
  frozenAt: z.string().min(1),
  business: z.string().min(1),
  salesStrategy: z.string().min(1),
  targetCountries: z.array(z.string()),
  strategies: z.array(z.object({ slug: z.string().min(1), approach: z.string().min(1), count: z.number().int().positive() })).min(1),
})

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

export const referenceSchema = z.object({
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

export const labelsSchema = z.record(
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

export function targetDir(target: string): string {
  const dir = resolve(DATA, target)
  if (!existsSync(dir)) throw new Error(`${dir} not found — create the target's spec.json first (see eval/README.md)`)
  return dir
}

export function readJson<T>(path: string, schema: z.ZodType<T>): T {
  if (!existsSync(path)) throw new Error(`${path} not found`)
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')))
}

export function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function envKey(name: string): string {
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

export async function snapshotSite(url: string): Promise<string> {
  const front = await fetchPage(url)
  if ('error' in front) return `# ${url}\n\nFETCH FAILED: ${front.error}\n`
  const parts = [`# ${url}\n\n## ${front.url} (HTTP ${front.status})\n\n${toText(front.html).slice(0, 12_000)}`]
  for (const link of linkedPages(front.html, front.url, 3)) {
    const page = await fetchPage(link)
    parts.push('error' in page ? `## ${link}\n\nFETCH FAILED: ${page.error}` : `## ${page.url} (HTTP ${page.status})\n\n${toText(page.html).slice(0, 8_000)}`)
  }
  return `${parts.join('\n\n')}\n`
}
