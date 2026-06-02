/**
 * Seed master_documents table from backend/seed-content/.
 *
 * Usage:
 *   # Read DATABASE_URL from current environment
 *   DATABASE_URL="postgresql://..." npx tsx scripts/seed-master-documents.ts
 *
 *   # Read DATABASE_URL from a dotenv-style file (e.g. backend/.env.production, gitignored)
 *   npx tsx scripts/seed-master-documents.ts --env-file=.env.production
 *
 *   # Preview what would change without writing
 *   npx tsx scripts/seed-master-documents.ts --env-file=.env.production --dry-run
 *
 * If DATABASE_URL is still unset (no env var, and any --env-file didn't define
 * it), it falls back to backend/.dev.vars (mirroring scripts/migrate.ts), so
 * the local-dev quickstart works bare.
 *
 * Source layout: every seed source lives in `backend/seed-content/<slug>.md`.
 * Skills fetch the content at runtime via the `get_master_document` MCP tool
 * (by slug), never via the `Read` tool against the file path.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres from 'postgres'

const __dirname = typeof import.meta.dirname === 'string'
  ? import.meta.dirname
  : dirname(fileURLToPath(import.meta.url))

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
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

// Fallback: load DATABASE_URL from backend/.dev.vars when not set in env or via
// --env-file, mirroring scripts/migrate.ts so the local-dev quickstart
// (`npx tsx scripts/seed-master-documents.ts`) works the same way
// `npm run db:migrate` does.
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

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (set in env, via --env-file=<path>, or in backend/.dev.vars)')
  process.exit(1)
}

const REPO_ROOT = resolve(__dirname, '../..')

const documents = [
  { slug: 'tpl_business', file: 'backend/seed-content/tpl_business.md' },
  { slug: 'tpl_sales_strategy', file: 'backend/seed-content/tpl_sales_strategy.md' },
  { slug: 'tpl_targeting_guide', file: 'backend/seed-content/tpl_targeting_guide.md' },
  { slug: 'tpl_email_templates', file: 'backend/seed-content/tpl_email_templates.md' },
  { slug: 'tpl_email_guidelines', file: 'backend/seed-content/tpl_email_guidelines.md' },
  { slug: 'tpl_channel_policy', file: 'backend/seed-content/tpl_channel_policy.md' },
  { slug: 'tpl_enrich_contacts', file: 'backend/seed-content/tpl_enrich_contacts.md' },
  { slug: 'tpl_industries', file: 'backend/seed-content/tpl_industries.md' },
  { slug: 'tpl_analysis_frameworks', file: 'backend/seed-content/tpl_analysis_frameworks.md' },
  { slug: 'ref_scheduling_services', file: 'backend/seed-content/ref_scheduling_services.md' },
]

function readContent(relPath: string): string {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf-8')
}

async function main() {
  const sql = postgres(DATABASE_URL!)

  try {
    const existing = new Map<string, string>()
    const rows = await sql<{ slug: string; content: string }[]>`
      SELECT slug, content FROM master_documents WHERE slug = ANY(${documents.map((d) => d.slug)})
    `
    for (const row of rows) existing.set(row.slug, row.content)

    const plan: Array<{
      slug: string
      action: 'INSERT' | 'UPDATE' | 'NOOP'
      bytes: number
      content: string
    }> = []
    for (const doc of documents) {
      const content = readContent(doc.file)
      const prev = existing.get(doc.slug)
      const action = prev === undefined ? 'INSERT' : prev === content ? 'NOOP' : 'UPDATE'
      plan.push({ slug: doc.slug, action, bytes: content.length, content })
    }

    const target = (() => {
      try {
        return new URL(DATABASE_URL!).host
      } catch {
        return '?'
      }
    })()
    console.log(`Target: ${target}`)
    console.log(`Plan (${dryRun ? 'dry-run' : 'apply'}):`)
    for (const p of plan) {
      const marker = p.action === 'NOOP' ? '·' : p.action === 'INSERT' ? '+' : '~'
      console.log(`  ${marker} ${p.slug.padEnd(28)} ${p.action.padEnd(6)} ${p.bytes} chars`)
    }
    const counts = plan.reduce<Record<string, number>>((acc, p) => {
      acc[p.action] = (acc[p.action] ?? 0) + 1
      return acc
    }, {})
    console.log(`Summary: INSERT=${counts['INSERT'] ?? 0}, UPDATE=${counts['UPDATE'] ?? 0}, NOOP=${counts['NOOP'] ?? 0}`)

    if (dryRun) {
      console.log('\nDry run — no changes written.')
      return
    }

    let applied = 0
    for (const p of plan) {
      if (p.action === 'NOOP') continue
      await sql`
        INSERT INTO master_documents (slug, content, version, updated_at)
        VALUES (${p.slug}, ${p.content}, 1, NOW())
        ON CONFLICT (slug)
        DO UPDATE SET content = ${p.content}, version = master_documents.version + 1, updated_at = NOW()
      `
      applied++
    }
    console.log(`\nDone: ${applied} master documents seeded (${documents.length - applied} unchanged).`)
  } finally {
    await sql.end()
  }
}

main()
