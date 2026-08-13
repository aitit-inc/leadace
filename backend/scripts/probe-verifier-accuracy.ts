/**
 * Scores the shipped verifier (Emailable, since 2026-08-13 — MillionVerifier
 * blocked CF egress) against the labels dump-bounce-groundtruth.ts emits, run
 * through the shipped send gate. Spends one credit per address; touches no DB.
 *
 * Trust boundary before rerunning: the blocking rule is imported from
 * domain/email-verification, so rule changes flow into the scoring
 * automatically — a same-vendor rerun on grown ground truth is trustworthy
 * as-is. What does NOT auto-track: the vendor endpoint/response mapping
 * hardcoded below, and any future gate logic that reads more than `result`.
 * After a vendor swap or a gate-shape change, revise this script first or
 * its numbers are wrong.
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
const apiKey = process.env['EMAILABLE_API_KEY']
const inputPath = args.find((a) => a.startsWith('--input='))?.slice('--input='.length)
if (!apiKey || !inputPath) {
  console.error('EMAILABLE_API_KEY and --input=<groundtruth.json> are required')
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

type VerifierResult = {
  state?: string
  reason?: string
  score?: number
}

async function verify(email: string): Promise<VerifierResult | { error: string }> {
  const url = `https://api.emailable.com/v1/verify?api_key=${apiKey}&email=${encodeURIComponent(email)}&timeout=10`
  // 249 = still verifying server-side; the vendor's documented protocol is to
  // resend the same request until the verdict is ready.
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 3_000))
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
      if (res.status === 249) continue
      if (!res.ok) return { error: `http_${res.status}` }
      return (await res.json()) as VerifierResult
    } catch (e) {
      return { error: e instanceof Error ? e.name : 'fetch_failed' }
    }
  }
  return { error: 'still_249_after_retries' }
}

type Scored = { email: string; status: string; detail: string; quality: string }

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
        status: 'error' in r ? `ERR:${r.error}` : (r.state ?? 'no_state'),
        detail: 'error' in r ? '-' : (r.reason ?? '-'),
        quality: 'error' in r ? '-' : String(r.score ?? '-'),
      }
      results.push(row)
      console.log(`  [${truth}] ${row.email.padEnd(38)} ${row.status.padEnd(12)} ${row.detail.padEnd(14)} ${row.quality}`)
    }
  }
  // Stay well under any vendor-side concurrency ceiling.
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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
