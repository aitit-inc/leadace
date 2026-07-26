/**
 * Scores a verifier against the labels dump-bounce-groundtruth.ts emits, run
 * through the shipped send gate. Spends one credit per address; touches no DB.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  verifierDeliverabilityVerdict,
  verifierStatusSchema,
} from '../src/domain/email-verification'
import { UNDELIVERABLE } from '../src/domain/email-deliverability'

const __dirname =
  typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
for (const arg of args.filter((a) => a.startsWith('--env-file='))) {
  const envPath = resolve(__dirname, arg.slice('--env-file='.length))
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
const apiKey = process.env['REOON_API_KEY']
const inputPath = args.find((a) => a.startsWith('--input='))?.slice('--input='.length)
if (!apiKey || !inputPath) {
  console.error('REOON_API_KEY and --input=<groundtruth.json> are required')
  process.exit(1)
}

const deadLimit = Number(args.find((a) => a.startsWith('--dead='))?.slice('--dead='.length) ?? 25)
const liveLimit = Number(args.find((a) => a.startsWith('--live='))?.slice('--live='.length) ?? 7)

const { dead: allDead, live: allLive } = JSON.parse(readFileSync(inputPath, 'utf-8')) as {
  dead: string[]
  live: string[]
}
const dead = allDead.slice(0, deadLimit)
const live = allLive.slice(0, liveLimit)

type ReoonResult = {
  status?: string
  overall_score?: number
  is_catch_all?: boolean
  can_connect_smtp?: boolean
  mx_records?: string[]
}

async function verify(email: string): Promise<ReoonResult | { error: string }> {
  const url = `https://emailverifier.reoon.com/api/v1/verify?email=${encodeURIComponent(email)}&key=${apiKey}&mode=power`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) return { error: `http_${res.status}` }
    return (await res.json()) as ReoonResult
  } catch (e) {
    return { error: e instanceof Error ? e.name : 'fetch_failed' }
  }
}

function provider(mx: string[] | undefined): string {
  const hosts = (mx ?? []).map((h) => h.toLowerCase().replace(/\.$/, ''))
  if (hosts.some((h) => h.includes('google'))) return 'google'
  if (hosts.some((h) => h.includes('outlook') || h.includes('microsoft'))) return 'microsoft'
  if (hosts.some((h) => h.includes('zoho'))) return 'zoho'
  if (hosts.length === 0) return 'no_mx'
  return 'other'
}

type Scored = { email: string; status: string; provider: string; score: number | string }

const blocks = (r: Scored): boolean =>
  verifierDeliverabilityVerdict(verifierStatusSchema.parse(r.status)) === UNDELIVERABLE

async function run(emails: string[], truth: string): Promise<Scored[]> {
  const results: Scored[] = []
  let next = 0
  const worker = async () => {
    while (next < emails.length) {
      const email = emails[next++]
      if (email === undefined) continue
      const r = await verify(email)
      const row: Scored = {
        email,
        status: 'error' in r ? `ERR:${r.error}` : (r.status ?? 'no_status'),
        provider: 'error' in r ? '-' : provider(r.mx_records),
        score: 'error' in r ? '-' : (r.overall_score ?? '-'),
      }
      results.push(row)
      console.log(`  [${truth}] ${row.email.padEnd(38)} ${row.status.padEnd(12)} ${row.provider.padEnd(10)} ${row.score}`)
    }
  }
  // Reoon asks for no more than 5 concurrent single-verify calls.
  await Promise.all(Array.from({ length: 3 }, worker))
  return results
}

function tally(label: string, rows: Scored[]): void {
  console.log(`\n-- ${label} status tally --`)
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(3)}  ${((v / rows.length) * 100).toFixed(0)}%`)
  }
}

async function main(): Promise<void> {
  console.log(`DEAD (user-unknown DSN → does not exist): ${dead.length}`)
  console.log(`LIVE (human replied → exists):           ${live.length}`)
  console.log(`credits to spend: ${dead.length + live.length}\n`)

  console.log('===== DEAD set =====')
  const deadResults = await run(dead, 'dead')
  tally('DEAD', deadResults)

  console.log('\n===== LIVE set =====')
  const liveResults = await run(live, 'live')
  tally('LIVE', liveResults)

  const caught = deadResults.filter(blocks).length
  const falseBlocks = liveResults.filter(blocks).length

  console.log('\n===== send-gate outcome =====')
  console.log(`dead caught (bounce prevented):   ${caught}/${deadResults.length}  ${((caught / Math.max(deadResults.length, 1)) * 100).toFixed(0)}%`)
  console.log(`dead missed (would still bounce): ${deadResults.length - caught}/${deadResults.length}`)
  console.log(`live wrongly blocked (lost lead): ${falseBlocks}/${liveResults.length}`)

  for (const p of ['google', 'microsoft', 'zoho', 'other', 'no_mx']) {
    const subset = deadResults.filter((r) => r.provider === p)
    if (subset.length === 0) continue
    const hit = subset.filter(blocks).length
    console.log(`  dead on ${p.padEnd(10)} caught ${hit}/${subset.length}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
