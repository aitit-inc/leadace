// Criterion H — learning velocity — read out of production's own record.
//
// The targeting bandit learns from rewardSum, which by default weights a
// negative reply at zero (domain/reward.ts), so a segment that answers "no,
// because X" scores the same as one that never answers. This counts every
// signal a send came back with, weighted or not.
//
// Read-only, one tenant: the contract a reader needs before pointing this at
// production.
//
//   npx tsx eval/learning.ts --tenant <tenantId> [--project <projectId>] [--out <dir>]
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import postgres from 'postgres'

type Arg = 'tenant' | 'project' | 'out'

function arg(name: Arg): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

type CaptureRow = { projectId: string; month: string; sent: number; prospects: number; withResponse: number; withHumanReply: number; withInquiry: number; withAnySignal: number }
type SendRow = { projectId: string; month: string; status: string; channel: string; skipReason: string | null; errorMessage: string | null; count: number }
type ReplyRow = { projectId: string; month: string; responseType: string; sentiment: string; withFeedback: number; count: number }
type ProspectRow = { projectId: string; doNotContact: number; reapproachDue: number; reapproachWaiting: number; total: number }
type InquiryRow = { projectId: string; outcome: string; withResponse: number; count: number }

async function main(): Promise<void> {
  const tenantId = arg('tenant')
  if (!tenantId) throw new Error('--tenant is required')
  const projectId = arg('project') ?? null
  const out = resolve(arg('out') ?? 'eval/data.local/learning')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is not set (run with --env-file=.env.production)')

  const sql = postgres(databaseUrl, { prepare: false })
  try {
    const data = await sql.begin(async (tx) => {
      // One snapshot across the four aggregates: read committed would let a
      // reply land between two of them and be counted once, or not at all.
      await tx`set transaction isolation level repeatable read, read only`

      // The rate-ready aggregate. Event counts cannot give "what share of sends
      // came back with something": a send can carry several responses, and an
      // inquiry session and its response are the same signal counted twice.
      const capture = await tx<CaptureRow[]>`
        select o.project_id as "projectId", to_char(o.sent_at, 'YYYY-MM') as month,
               count(distinct o.id)::int as sent,
               count(distinct o.prospect_id)::int as prospects,
               count(distinct o.id) filter (where r.id is not null)::int as "withResponse",
               count(distinct o.id) filter (where r.response_type not in ('bounce', 'auto_reply'))::int as "withHumanReply",
               count(distinct o.id) filter (where s.id is not null)::int as "withInquiry",
               count(distinct o.id) filter (where r.id is not null or s.id is not null)::int as "withAnySignal"
        from outreach_logs o
        left join responses r on r.outreach_log_id = o.id
        left join inquiry_sessions s on s.outreach_log_id = o.id
        where o.tenant_id = ${tenantId} and (${projectId}::text is null or o.project_id = ${projectId}) and o.status = 'sent'
        group by 1, 2
        order by 1, 2`

      const sends = await tx<SendRow[]>`
        select project_id as "projectId", to_char(sent_at, 'YYYY-MM') as month, status::text, channel::text,
               skip_reason::text as "skipReason", left(error_message, 60) as "errorMessage",
               count(*)::int as count
        from outreach_logs
        where tenant_id = ${tenantId} and (${projectId}::text is null or project_id = ${projectId})
        group by 1, 2, 3, 4, 5, 6
        order by 1, 2, 3, 4, 5, 6`

      const replies = await tx<ReplyRow[]>`
        select o.project_id as "projectId", to_char(r.received_at, 'YYYY-MM') as month,
               r.response_type::text as "responseType", r.sentiment::text,
               count(*) filter (where r.rejection_feedback is not null)::int as "withFeedback",
               count(*)::int as count
        from responses r
        join outreach_logs o on o.id = r.outreach_log_id
        where r.tenant_id = ${tenantId} and (${projectId}::text is null or o.project_id = ${projectId})
        group by 1, 2, 3, 4
        order by 1, 2, 3, 4`

      const prospects = await tx<ProspectRow[]>`
        select pp.project_id as "projectId",
               count(*) filter (where p.do_not_contact)::int as "doNotContact",
               count(*) filter (where p.next_outreach_after <= now())::int as "reapproachDue",
               count(*) filter (where p.next_outreach_after > now())::int as "reapproachWaiting",
               count(*)::int as total
        from project_prospects pp
        join prospects p on p.id = pp.prospect_id
        where pp.tenant_id = ${tenantId} and (${projectId}::text is null or pp.project_id = ${projectId})
        group by 1
        order by 1`

      const inquiries = await tx<InquiryRow[]>`
        select o.project_id as "projectId", s.outcome::text,
               count(*) filter (where s.response_id is not null)::int as "withResponse",
               count(*)::int as count
        from inquiry_sessions s
        join outreach_logs o on o.id = s.outreach_log_id
        where s.tenant_id = ${tenantId} and (${projectId}::text is null or o.project_id = ${projectId})
        group by 1, 2
        order by 1, 2`

      return { capture, sends, replies, prospects, inquiries }
    })

    await mkdir(out, { recursive: true })
    await writeFile(`${out}/learning.json`, JSON.stringify({ tenantId, projectId, readAt: new Date().toISOString(), ...data }, null, 2))
    console.log(`capture rows   ${data.capture.length}`)
    console.log(`send rows      ${data.sends.length}`)
    console.log(`reply rows     ${data.replies.length}`)
    console.log(`prospect rows  ${data.prospects.length}`)
    console.log(`inquiry rows   ${data.inquiries.length}`)
    console.log(`→ ${out}/learning.json`)
  } finally {
    await sql.end()
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exit(1)
})
