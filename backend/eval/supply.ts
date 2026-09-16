// Criterion C — supply durability — read out of production's own journal.
//
// The daily lever tick already records, per strategy, how many prospects
// yesterday's plan brought in (services/levers.ts § loadPriorDayRegistrations),
// and a persistent gap between plan and registrations marks the failure this
// measures: a strategy the LLM cannot execute. So the decay curve needs a read,
// not a synthetic run.
//
// Read-only, one tenant: the contract a reader needs before pointing this at
// production.
//
//   npx tsx eval/supply.ts --tenant <tenantId> [--project <projectId>] [--out <dir>]
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

type Arg = 'tenant' | 'project' | 'out'

function arg(name: Arg): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

type StrategyRow = { projectId: string; slug: string; approach: string; createdAt: string; archivedAt: string | null }
type DecisionRow = { projectId: string; cycleDate: string; discovery: unknown; targeting: unknown }
type JobRow = { projectId: string; id: string; kind: string; startedBy: string; status: string; createdAt: string; params: unknown; result: unknown; discoverStages: string[] }
type OrgRow = { domain: string; projectId: string; firstLinkedAt: string; slugs: string[] }
type RegistrationRow = { day: string; slug: string | null; origin: string; count: number }
type NotesRow = { createdAt: string; content: string }

async function main(): Promise<void> {
  const tenantId = arg('tenant')
  if (!tenantId) throw new Error('--tenant is required')
  const projectId = arg('project') ?? null
  const out = resolve(arg('out') ?? 'eval/data.local/supply')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (run with --env-file=.env.production)')

  const sql = postgres(databaseUrl, { prepare: false })
  try {
    const data = await sql.begin(async (tx) => {
      await tx`set transaction read only`
      const strategies = await tx<StrategyRow[]>`
        select project_id as "projectId", slug, approach, created_at as "createdAt", archived_at as "archivedAt"
        from discovery_strategies
        where tenant_id = ${tenantId} and (${projectId}::text is null or project_id = ${projectId})
        order by project_id, created_at`

      const decisions = await tx<DecisionRow[]>`
        select project_id as "projectId", cycle_date as "cycleDate", decision -> 'discovery' as discovery, decision -> 'targeting' as targeting
        from lever_decisions
        where tenant_id = ${tenantId} and (${projectId}::text is null or project_id = ${projectId})
        order by cycle_date`

      const jobs = await tx<JobRow[]>`
        select project_id as "projectId", id, kind::text, started_by::text as "startedBy", status::text, created_at as "createdAt", params, result,
               coalesce((
                 select array_agg(entry ->> 'summary' order by ord)
                 from jsonb_array_elements(log) with ordinality as e(entry, ord)
                 where entry ->> 'stage' = 'discover'
               ), '{}') as "discoverStages"
        from jobs
        where tenant_id = ${tenantId} and (${projectId}::text is null or project_id = ${projectId}) and kind in ('discover', 'daily_cycle')
        order by created_at`

      const registrations = await tx<RegistrationRow[]>`
        select date(pp.created_at)::text as day, p.discovery_strategy as slug, p.origin::text as origin, count(*)::int as count
        from project_prospects pp
        join prospects p on p.id = pp.prospect_id
        where pp.tenant_id = ${tenantId} and (${projectId}::text is null or pp.project_id = ${projectId})
        group by 1, 2, 3
        order by 1, 2`

      const orgs = await tx<OrgRow[]>`
        select o.domain, pp.project_id as "projectId", min(pp.created_at)::text as "firstLinkedAt",
               array_remove(array_agg(distinct p.discovery_strategy), null) as slugs
        from project_prospects pp
        join prospects p on p.id = pp.prospect_id
        join organizations o on o.id = p.organization_id
        where pp.tenant_id = ${tenantId} and (${projectId}::text is null or pp.project_id = ${projectId})
        group by 1, 2
        order by 3`

      const notes = await tx<NotesRow[]>`
        select created_at as "createdAt", content
        from project_documents
        where tenant_id = ${tenantId} and (${projectId}::text is null or project_id = ${projectId}) and slug = 'search_notes'
        order by created_at`

      return { strategies, decisions, jobs, registrations, orgs, notes }
    })

    await mkdir(out, { recursive: true })
    await writeFile(`${out}/supply.json`, JSON.stringify({ tenantId, projectId, readAt: new Date().toISOString(), ...data }, null, 2))
    await writeFile(
      `${out}/search_notes.md`,
      data.notes.map((n) => `<!-- ${n.createdAt} — ${n.content.length} chars -->\n\n${n.content}`).join('\n\n---\n\n'),
    )

    console.log(`strategies        ${data.strategies.length}`)
    console.log(`lever decisions   ${data.decisions.length}  ${data.decisions.at(0)?.cycleDate ?? '-'} … ${data.decisions.at(-1)?.cycleDate ?? '-'}`)
    console.log(`jobs              ${data.jobs.length}`)
    console.log(`registration rows ${data.registrations.length}`)
    console.log(`org domains       ${data.orgs.length}`)
    console.log(`search_notes      ${data.notes.length} versions`)
    console.log(`→ ${out}/supply.json`)
  } finally {
    await sql.end()
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
