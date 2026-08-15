/**
 * One-time backfill of the discovery_strategies registry (PR-A of the
 * autonomy-loop work). Sources, per project:
 *   1. `### <slug>` entries of the latest sales_strategy document's
 *      "## Prospect Discovery Sources" section — carries the approach text and
 *      the prose `Status: paused` state (backfilled as archived).
 *   2. DISTINCT prospects.discovery_strategy of project-linked prospects.
 *      Slugs with historic attribution but no prose entry backfill as
 *      **archived** with a placeholder approach: the prose section is the
 *      declared portfolio, so a slug absent from it was removed or renamed —
 *      reviving it would silently re-activate abandoned strategies. Archived
 *      rows keep historic attribution analysable; un-archive via
 *      upsert_discovery_strategy if one is wanted back.
 *
 * The maxActiveStrategies cap is enforced on upserts only; a prose section
 * declaring more active entries than the cap backfills as-is and is reported
 * as a warning for the operator to resolve.
 *
 * Idempotent: ON CONFLICT (project_id, slug) DO NOTHING — re-runs never
 * overwrite an approach that evaluate has since refined.
 *
 * Usage (mirrors seed-master-documents.ts):
 *   DATABASE_URL="postgresql://..." npx tsx scripts/backfill-discovery-strategies.ts
 *   npx tsx scripts/backfill-discovery-strategies.ts --env-file=.env.production --dry-run
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

if (!process.env['DATABASE_URL']) {
  const devVarsPath = resolve(__dirname, '..', '.dev.vars')
  if (existsSync(devVarsPath)) {
    for (const line of readFileSync(devVarsPath, 'utf-8').split('\n')) {
      const m = line.match(/^\s*DATABASE_URL\s*=\s*(.*)\s*$/)
      if (m) process.env['DATABASE_URL'] = m[1]!.replace(/^["']|["']$/g, '')
    }
  }
}

const databaseUrl = process.env['DATABASE_URL']
if (!databaseUrl) {
  console.error('DATABASE_URL is not set (env, --env-file, or .dev.vars)')
  process.exit(1)
}

const SLUG_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/
const PLACEHOLDER_APPROACH =
  'Backfilled from historical registrations; refine via upsert_discovery_strategy.'
const MAX_ACTIVE_STRATEGIES = 6

type ParsedEntry = { slug: string; approach: string; paused: boolean }

export function parseDiscoverySection(markdown: string): ParsedEntry[] {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => /^##\s+Prospect Discovery Sources\s*$/.test(l))
  if (start === -1) return []

  const entries: ParsedEntry[] = []
  let current: { slug: string; body: string[]; paused: boolean } | null = null
  const flush = () => {
    if (!current) return
    const approach = current.body.join('\n').trim()
    entries.push({
      slug: current.slug,
      approach: approach || PLACEHOLDER_APPROACH,
      paused: current.paused,
    })
    current = null
  }

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!
    if (/^##\s/.test(line)) break
    const heading = line.match(/^###\s+(.+)$/)
    if (heading) {
      flush()
      const slug = heading[1]!.trim()
      current = SLUG_REGEX.test(slug) ? { slug, body: [], paused: false } : null
      continue
    }
    if (!current) continue
    const status = line.match(/^\s*[-*]\s+Status:\s*(\S+)/i)
    if (status) {
      current.paused = status[1]!.toLowerCase() === 'paused'
      continue
    }
    if (line.trim() !== '') current.body.push(line.trimEnd())
  }
  flush()
  return entries
}

async function main(): Promise<void> {
  const sql = postgres(databaseUrl!, { max: 1, prepare: false })
  try {
    const docs = await sql<Array<{ tenantId: string; projectId: string; content: string }>>`
      SELECT DISTINCT ON (project_id) tenant_id AS "tenantId", project_id AS "projectId", content
      FROM project_documents
      WHERE slug = 'sales_strategy'
      ORDER BY project_id, created_at DESC
    `
    const attributed = await sql<Array<{ tenantId: string; projectId: string; slug: string }>>`
      SELECT DISTINCT pp.tenant_id AS "tenantId", pp.project_id AS "projectId", p.discovery_strategy AS slug
      FROM prospects p
      JOIN project_prospects pp ON pp.prospect_id = p.id AND pp.tenant_id = p.tenant_id
      WHERE p.discovery_strategy IS NOT NULL
    `

    // Prose entries first so their approach/status win the merge. Neither
    // projectId nor slug can contain a space, so the map key is collision-safe.
    const rows = new Map<string, { tenantId: string; projectId: string; slug: string; approach: string; archived: boolean }>()
    for (const doc of docs) {
      for (const entry of parseDiscoverySection(doc.content)) {
        rows.set(`${doc.projectId} ${entry.slug}`, {
          tenantId: doc.tenantId,
          projectId: doc.projectId,
          slug: entry.slug,
          approach: entry.approach,
          archived: entry.paused,
        })
      }
    }
    for (const row of attributed) {
      if (!SLUG_REGEX.test(row.slug)) {
        console.warn(`skip (invalid slug shape): project ${row.projectId} slug "${row.slug}"`)
        continue
      }
      const key = `${row.projectId} ${row.slug}`
      if (!rows.has(key)) {
        rows.set(key, { ...row, approach: PLACEHOLDER_APPROACH, archived: true })
      }
    }

    const plan = Array.from(rows.values())
    console.log(`${plan.length} strategy row(s) across ${new Set(plan.map((r) => r.projectId)).size} project(s)`)
    const activePerProject = new Map<string, number>()
    for (const r of plan) {
      console.log(`  ${r.projectId} ${r.slug}${r.archived ? ' (archived)' : ''}`)
      if (!r.archived) activePerProject.set(r.projectId, (activePerProject.get(r.projectId) ?? 0) + 1)
    }
    for (const [projectId, count] of activePerProject) {
      if (count > MAX_ACTIVE_STRATEGIES) {
        console.warn(`WARNING: project ${projectId} backfills ${count} active strategies (cap ${MAX_ACTIVE_STRATEGIES}) — archive the surplus via upsert_discovery_strategy`)
      }
    }
    if (dryRun) {
      console.log('dry-run: no writes')
      return
    }

    let inserted = 0
    for (const r of plan) {
      const result = await sql`
        INSERT INTO discovery_strategies (tenant_id, project_id, slug, approach, archived_at)
        VALUES (${r.tenantId}, ${r.projectId}, ${r.slug}, ${r.approach}, ${r.archived ? sql`now()` : null})
        ON CONFLICT (project_id, slug) DO NOTHING
      `
      inserted += result.count
    }
    console.log(`inserted ${inserted} row(s) (${plan.length - inserted} already present)`)
  } finally {
    await sql.end()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
