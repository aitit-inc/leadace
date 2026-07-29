/**
 * The question source-driven discovery actually turns on: can one prompt read a
 * source it has never seen?
 *
 * probe-source-shape.ts established what a page announces about itself. This
 * establishes whether anything can be pulled out of it. The same "list of
 * tender notices" arrives as JSON, as RSS, as an HTML table and as an ASP form,
 * and Japanese public bodies date theirs in 令和 — writing that deterministically
 * is one extractor per publisher, which is the pattern explosion memo ㊴ says to
 * hand to a model instead.
 *
 * So the prompt below is deliberately generic and is NOT tuned per source. If
 * it needs per-source hints the premise fails, and that is the finding.
 *
 * Runs through callGeminiUrlContext — the same path org-signals ships — so a
 * result here is a result about production, not about a lab. Extraction quality
 * is not self-scoring: it prints every record so they can be checked against
 * the page, because a model asked to find events will happily invent them.
 *
 * Usage:
 *   npx tsx scripts/probe-source-extraction.ts --secrets=.dev.vars --file=urls.txt
 *   npx tsx scripts/probe-source-extraction.ts --secrets=.dev.vars --file=urls.txt --self-fetch
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Schema } from '@google/genai'
import { callGeminiStructured, callGeminiUrlContext, GeminiError } from '../src/services/gemini'

const MODEL = 'gemini-3.1-flash-lite'
const USER_AGENT = 'LeadAceBot/1.0 (+https://leadace.ai)'
// Tokyo's notice list is half a megabyte of HTML; the visible text of even that
// fits well inside the window, and cutting mid-page loses only the tail.
const MAX_TEXT_CHARS = 120_000

const flag = (name: string): string | undefined =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)

// Not --env-file: node claims that one and never passes it through.
for (const arg of process.argv.slice(2).filter((a) => a.startsWith('--secrets='))) {
  const envPath = resolve(process.cwd(), arg.slice('--secrets='.length))
  if (!existsSync(envPath)) {
    console.error(`secrets file not found: ${envPath}`)
    process.exit(1)
  }
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i)
    if (m === null) continue
    let value = m[2]!
    if (value.length >= 2 && /^["']/.test(value) && value.endsWith(value[0]!)) {
      value = value.slice(1, -1)
    }
    process.env[m[1]!] = value
  }
}

const RECORD_SCHEMA: Schema = {
  type: 'object',
  properties: {
    sourceKind: { type: 'string' },
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entityName: { type: 'string' },
          entityUrl: { type: 'string' },
          eventTitle: { type: 'string' },
          eventDate: { type: 'string' },
          confidence: { type: 'string' },
        },
        required: ['entityName', 'eventTitle', 'eventDate', 'confidence'],
      },
    },
  },
  required: ['sourceKind', 'records'],
}

/**
 * One prompt for every source. It names no publisher, no layout and no date
 * notation, because the whole point is whether an unseen page can be read
 * without being anticipated.
 */
const extractionPrompt = (url: string, today: string): string => `Read ${url}.

It is a page someone might watch for sales signals. Work out what it lists, then
extract the entries.

Rules — these bind every field, and an empty answer beats a guessed one:
- Only report what is written on the page. Never infer, complete or recall an
  entry from your own knowledge. If the page did not load, return no records.
- entityName: the organisation the entry is about — the buyer that published a
  notice, the company behind a product, the owner of a repository. Not the
  publisher of the page unless the page is about itself.
- eventTitle: what happened, in one line, in the page's own language.
- eventDate: the date the page gives for that entry, as YYYY-MM-DD. Convert
  other notations, including Japanese imperial era years, to that form. Use ""
  when the entry carries no date — never substitute today's date (${today}) or
  a date from elsewhere on the page.
- entityUrl: the entry's own link if it has one, else "".
- confidence: "high" when entity, event and date are all explicit; "low" when
  any of them took interpretation.
- sourceKind: one line on what this page is and what its entries represent.

Return at most 25 records.`

const visibleText = (html: string): string =>
  html
    .replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const CHARSET = /charset=["']?([A-Za-z0-9_-]+)/i

/**
 * Japanese public bodies still serve Shift_JIS and often declare it only in a
 * meta tag, so res.text() — which assumes UTF-8 — hands the model mojibake and
 * every field downstream is then guesswork. Encoding is code's job precisely
 * because the answer is unique and getting it wrong fails silently.
 */
function decode(buf: ArrayBuffer, contentType: string): string {
  const head = new TextDecoder('latin1').decode(buf.slice(0, 4096))
  const declared = CHARSET.exec(contentType)?.[1] ?? CHARSET.exec(head)?.[1]
  if (declared === undefined || /^utf-?8$/i.test(declared)) return new TextDecoder().decode(buf)
  try {
    return new TextDecoder(declared).decode(buf)
  } catch {
    return new TextDecoder().decode(buf)
  }
}

async function fetchText(url: string): Promise<{ text: string; charset: string } | null> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25_000),
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') ?? ''
    const buf = await res.arrayBuffer()
    const body = decode(buf, type)
    const head = new TextDecoder('latin1').decode(buf.slice(0, 4096))
    const charset = CHARSET.exec(type)?.[1] ?? CHARSET.exec(head)?.[1] ?? 'utf-8 (assumed)'
    const text = /json|xml/.test(type) ? body : visibleText(body)
    return { text: text.slice(0, MAX_TEXT_CHARS), charset }
  } catch {
    return null
  }
}

type Record = {
  entityName: string
  entityUrl?: string
  eventTitle: string
  eventDate: string
  confidence: string
}

async function probe(url: string, apiKey: string, selfFetch: boolean): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  console.log(`\n${'─'.repeat(76)}\n${url}`)
  try {
    let raw: string
    if (selfFetch) {
      const fetched = await fetchText(url)
      if (fetched === null) {
        console.log('  FETCH FAILED — our own request did not return a body either')
        return
      }
      console.log(`  fetched ${fetched.text.length} chars ourselves · charset ${fetched.charset}`)
      raw = await callGeminiStructured({
        apiKey,
        model: MODEL,
        prompt: `${extractionPrompt(url, today)}\n\nPage content:\n\n${fetched.text}`,
        responseSchema: RECORD_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 8192,
      })
    } else {
      const read = await callGeminiUrlContext({
        apiKey,
        model: MODEL,
        prompt: extractionPrompt(url, today),
        responseSchema: RECORD_SCHEMA,
        temperature: 0.1,
        maxOutputTokens: 8192,
      })
      if (read.retrievedUrls.length === 0) {
        console.log('  NOT RETRIEVED — the page never loaded, so any answer would be recall')
        return
      }
      raw = read.text
    }
    const parsed: unknown = JSON.parse(raw)
    const { sourceKind, records } = parsed as { sourceKind: string; records: Record[] }
    const dated = records.filter((r) => r.eventDate !== '')
    const highConf = records.filter((r) => r.confidence === 'high')
    const named = records.filter((r) => r.entityName !== '')
    console.log(`  kind: ${sourceKind}`)
    console.log(
      `  records ${records.length} · with a date ${dated.length} · with an entity ${named.length} · high confidence ${highConf.length}`,
    )
    for (const r of records.slice(0, 8)) {
      console.log(
        `    [${r.confidence[0]}] ${r.eventDate === '' ? '(no date)' : r.eventDate}  ${r.entityName}  — ${r.eventTitle.slice(0, 70)}`,
      )
    }
    if (records.length > 8) console.log(`    … ${records.length - 8} more`)
  } catch (e) {
    const detail = e instanceof GeminiError ? `${e.status} ${e.message}` : (e as Error).message
    console.log(`  FAILED: ${detail}`)
  }
}

async function main(): Promise<void> {
  const apiKey = process.env['GEMINI_API_KEY']
  if (apiKey === undefined || apiKey === '') {
    console.error('GEMINI_API_KEY missing — pass --secrets=.dev.vars')
    process.exit(1)
  }
  const fileFlag = flag('file')
  const urls =
    fileFlag === undefined
      ? process.argv.slice(2).filter((a) => !a.startsWith('--'))
      : readFileSync(fileFlag, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '' && !l.startsWith('#'))
  if (urls.length === 0) {
    console.error('give at least one URL, or --file=urls.txt')
    process.exit(1)
  }
  const selfFetch = process.argv.slice(2).includes('--self-fetch')
  console.log(
    `extracting from ${urls.length} sources with one generic prompt (${MODEL}, ` +
      `${selfFetch ? 'we fetch the page' : 'url_context fetches the page'})`,
  )
  for (const url of urls) await probe(url, apiKey, selfFetch)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
