/**
 * Read-only against prod: classifies bounces by DSN reason. Only user_unknown is
 * a class a mailbox verifier could ever have caught.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const __dirname =
  typeof import.meta.dirname === 'string' ? import.meta.dirname : dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const envFileArg = args.find((a) => a.startsWith('--env-file='))
if (envFileArg) {
  const envPath = resolve(__dirname, envFileArg.slice('--env-file='.length))
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
const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

function classifyBounce(content: string): string {
  const c = content.toLowerCase()
  if (/5\.1\.1|5\.1\.10|550[ -]?5\.1\.1|user unknown|no such user|recipient not found|address not found|does not exist|unknown recipient|mailbox unavailable|invalid recipient|user not found/.test(c))
    return 'user_unknown'
  if (/5\.7\.1|5\.7\.0|5\.7\.26|spam|policy|blocked|blacklist|reject.*content|unsolicited|dmarc|spf|dkim/.test(c))
    return 'policy_spam'
  if (/4\.2\.2|5\.2\.2|quota|mailbox full|over quota/.test(c)) return 'mailbox_full'
  if (/4\.7\.|4\.4\.|try again later|temporar|rate limit|throttl|deferred|greylist/.test(c))
    return 'transient'
  if (/5\.1\.2|domain not found|no mx|host unknown|dns/.test(c)) return 'domain_unknown'
  if (/5\.4\.1|relay access denied|5\.7\.13|disabled|suspended|deactivated/.test(c))
    return 'mailbox_disabled'
  return 'unclassified'
}

const sql = postgres(databaseUrl, { max: 2, prepare: false })

async function main(): Promise<void> {
  const rows = (await sql`
    SELECT p.email AS email, r.content AS content, r.received_at AS received_at
    FROM responses r
    JOIN outreach_logs ol ON ol.id = r.outreach_log_id AND ol.tenant_id = r.tenant_id
    JOIN prospects p ON p.id = ol.prospect_id AND p.tenant_id = ol.tenant_id
    WHERE r.response_type = 'bounce'
      AND p.email IS NOT NULL
    ORDER BY r.received_at DESC
  `) as unknown as Array<{ email: string; content: string; received_at: Date }>

  const byClass = new Map<string, Array<{ email: string; content: string }>>()
  for (const r of rows) {
    const k = classifyBounce(r.content)
    const list = byClass.get(k) ?? []
    list.push({ email: r.email, content: r.content })
    byClass.set(k, list)
  }

  console.log(`total bounce rows: ${rows.length}\n`)
  for (const [k, list] of [...byClass].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${k.padEnd(18)} ${String(list.length).padStart(4)}  ${((list.length / rows.length) * 100).toFixed(1)}%`)
  }

  console.log('\n===== user_unknown addresses (what a verifier could have caught) =====')
  for (const r of byClass.get('user_unknown') ?? []) console.log(`  ${r.email}`)

  console.log('\n===== unclassified samples (first 6, truncated) =====')
  for (const r of (byClass.get('unclassified') ?? []).slice(0, 6)) {
    console.log(`--- ${r.email}`)
    console.log(`    ${r.content.replace(/\s+/g, ' ').slice(0, 400)}`)
  }

  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
