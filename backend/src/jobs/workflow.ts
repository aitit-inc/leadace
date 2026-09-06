// The Workflow behind every jobs row. Cloudflare re-runs `run` from the top
// after each hibernation with completed steps replayed from cache, so the
// only work outside a step is reading the row and writing its final status.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Env } from '../api/types'
import { createDb } from '../db/connection'
import { withTenantConnection } from '../db/rls'
import type { JobResult } from '../domain/jobs'
import { asTenantId } from '../domain/ids'
import { finishJob, loadJobForRun, markJobRunning } from '../services/jobs'
import { appendJobNotice } from '../services/chat/threads'
import { runDailyCycle } from './daily-cycle'
import { discoverStage, draftStage, enrichStage, evaluateStage, journalStage, sendStage, type StageCtx } from './stages'

export type JobWorkflowParams = { jobId: string; tenantId: string }

const LOAD_RETRY = { retries: { limit: 5, delay: '2 seconds', backoff: 'exponential' }, timeout: '1 minute' } as const

async function runJob(ctx: StageCtx): Promise<JobResult> {
  const { params } = ctx.job
  switch (params.kind) {
    case 'daily_cycle':
      return runDailyCycle(ctx, params)
    case 'discover':
      return discoverStage(ctx, params)
    case 'enrich':
      return enrichStage(ctx, params.candidates)
    case 'draft':
      return draftStage(ctx, params)
    case 'send':
      return sendStage(ctx, params)
    case 'evaluate':
      return evaluateStage(ctx)
    case 'journal':
      return journalStage(ctx, null)
  }
}

export class LeadAceJobWorkflow extends WorkflowEntrypoint<Env, JobWorkflowParams> {
  override async run(event: Readonly<WorkflowEvent<JobWorkflowParams>>, step: WorkflowStep): Promise<void> {
    const { jobId, tenantId } = event.payload
    // The starter inserts the row in its request transaction and creates the
    // instance before that commits, so the first read may run ahead of the
    // row: a step retries until it is visible. Every write below is a step
    // too, so a replay after hibernation neither re-marks nor re-notifies.
    const job = await step.do('load', LOAD_RETRY, async () => {
      const row = await loadJobForRun(createDb(this.env.DATABASE_URL), asTenantId(tenantId), jobId)
      if (!row) throw new Error(`jobs row ${jobId} not visible yet for tenant ${tenantId}`)
      return row
    })
    if (job.status === 'cancelled') return
    await step.do('start', async () => {
      await markJobRunning(createDb(this.env.DATABASE_URL), job.tenantId, job.id)
      return true
    })

    let outcome: { ok: true; result: JobResult } | { ok: false; error: string }
    try {
      outcome = { ok: true, result: await runJob({ env: this.env, step, job }) }
    } catch (e) {
      outcome = { ok: false, error: (e instanceof Error ? e.message : String(e)).replace(/^NonRetryableError: /, '') }
    }
    // The notice lands before the status flips, so a poller that sees the
    // terminal status and refreshes finds the notice already there.
    if (job.threadId) {
      const threadId = job.threadId
      await step.do('notify-thread', async () => {
        await withTenantConnection(this.env.DATABASE_URL, job.tenantId, (tx) =>
          appendJobNotice(tx, job.tenantId, threadId, {
            jobId: job.id,
            kind: job.kind,
            status: outcome.ok ? 'succeeded' : 'failed',
            summary: outcome.ok ? outcome.result.summary : outcome.error,
          }),
        )
        return true
      })
    }
    await step.do('finish', async () => {
      await finishJob(createDb(this.env.DATABASE_URL), job.tenantId, job.id, outcome)
      return true
    })
  }
}
