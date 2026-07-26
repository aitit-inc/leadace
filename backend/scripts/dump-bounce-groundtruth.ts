/**
 * Read-only against prod. Emits the labelled sets probe-verifier-accuracy.ts
 * scores: `dead` returned a user-unknown DSN, `live` had its owner write back.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

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
const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const USER_UNKNOWN =
  /5\.1\.1|user unknown|no such user|recipient not found|address not found|does not exist|unknown recipient|mailbox unavailable|invalid recipient|user not found/i

const sql = postgres(databaseUrl, { max: 2, prepare: false })

async function main(): Promise<void> {
  const bounceRows = (await sql`
    SELECT DISTINCT p.email AS email, r.content AS content
    FROM responses r
    JOIN outreach_logs ol ON ol.id = r.outreach_log_id AND ol.tenant_id = r.tenant_id
    JOIN prospects p ON p.id = ol.prospect_id AND p.tenant_id = ol.tenant_id
    WHERE r.response_type = 'bounce' AND p.email IS NOT NULL
  `) as unknown as Array<{ email: string; content: string }>

  const dead = [...new Set(bounceRows.filter((r) => USER_UNKNOWN.test(r.content)).map((r) => r.email))]

  const liveRows = (await sql`
    SELECT DISTINCT p.email AS email
    FROM responses r
    JOIN outreach_logs ol ON ol.id = r.outreach_log_id AND ol.tenant_id = r.tenant_id
    JOIN prospects p ON p.id = ol.prospect_id AND p.tenant_id = ol.tenant_id
    WHERE r.response_type IN ('reply', 'rejection', 'meeting_request')
      AND p.email IS NOT NULL
  `) as unknown as Array<{ email: string }>

  const deadSet = new Set(dead)
  const live = [...new Set(liveRows.map((r) => r.email))].filter((e) => !deadSet.has(e))

  console.log(JSON.stringify({ dead, live }, null, 2))
  await sql.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
