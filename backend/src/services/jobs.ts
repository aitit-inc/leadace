// Jobs: the one way hosted-agent work is started, whoever asks (cron, chat,
// Web UI, MCP). A row is the record; the Workflow instance with the same id
// does the work (jobs/workflow.ts) and reports back through the row.
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { jobs, projectSettings, projects } from '../db/schema'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import { asProjectId, asTenantId, projectRefSchema } from '../domain/ids'
import {
  JOB_KINDS,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  jobParamsSchema,
  type JobKind,
  type JobOrigin,
  type JobParams,
  type JobProgress,
  type JobResult,
  type JobStatus,
} from '../domain/jobs'
import { randomFromAlphabet } from '../auth/random-id'
import { utcDateKey } from '../domain/time'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { getActiveStrategySlugs } from './discovery-strategies'

// The Workflow binding, narrowed to what this service needs so it stays
// testable and free of the Worker env type.
export type JobRunner = {
  create: (jobId: string, tenantId: TenantId) => Promise<void>
  // Resolves once the instance can no longer act: it was stopped, or had
  // already finished. Rejects when it is still running and could not be stopped.
  terminate: (jobId: string) => Promise<void>
}

export const startJobBodySchema = z
  .object({
    projectId: projectRefSchema,
    params: jobParamsSchema,
    // Chat thread to notify on completion. The hosted chat sets it on the
    // agent's behalf; any other caller may leave it out.
    threadId: z.string().min(1).max(64).optional(),
  })
  .strict()
export type StartJobBody = z.infer<typeof startJobBodySchema>

export const listJobsQuerySchema = z.object({
  projectId: projectRefSchema.optional(),
  threadId: z.string().min(1).max(64).optional(),
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.enum(JOB_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})
export type ListJobsQuery = z.infer<typeof listJobsQuerySchema>

export const jobIdParamSchema = z.object({ id: z.string().min(1).max(64) })

export type JobView = {
  id: string
  projectId: ProjectId
  kind: JobKind
  params: JobParams
  status: JobStatus
  progress: JobProgress | null
  result: JobResult | null
  error: string | null
  startedBy: JobOrigin
  threadId: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
}

const jobCols = {
  id: jobs.id,
  projectId: jobs.projectId,
  kind: jobs.kind,
  params: jobs.params,
  status: jobs.status,
  progress: jobs.progress,
  result: jobs.result,
  error: jobs.error,
  startedBy: jobs.startedBy,
  threadId: jobs.threadId,
  createdAt: jobs.createdAt,
  startedAt: jobs.startedAt,
  finishedAt: jobs.finishedAt,
}

type JobRow = typeof jobs.$inferSelect
function toView(row: Omit<JobRow, 'tenantId' | 'idempotencyKey'>): JobView {
  return { ...row, projectId: asProjectId(row.projectId) }
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// The daily cycle runs once per project per UTC day whoever starts it; every
// other kind may run as often as asked. A cycle that failed or was cancelled
// releases the key (finishJob / cancelJob) so the day can be re-run once the
// cause is fixed.
export function dailyCycleIdempotencyKey(projectId: ProjectId, now: Date): string {
  return `${projectId}:${utcDateKey(now)}`
}

export async function startJob(
  db: Db,
  tenantId: TenantId,
  runner: JobRunner,
  origin: JobOrigin,
  body: StartJobBody,
  now: Date = new Date(),
): Promise<ServiceResult<JobView>> {
  const resolved = await resolveProject(db, tenantId, body.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  if (body.params.kind === 'discover' && (await getActiveStrategySlugs(db, projectId)).length === 0) {
    return err(
      'PRECONDITION_FAILED',
      'No active discovery strategies',
      'Register at least one discovery strategy before collecting prospects — draft_strategy_from_url + apply_strategy_draft sets them up from the company website.',
    )
  }
  return insertAndRun(db, tenantId, projectId, runner, origin, body.params, body.threadId ?? null, now)
}

async function insertAndRun(
  db: Db,
  tenantId: TenantId,
  projectId: ProjectId,
  runner: JobRunner,
  origin: JobOrigin,
  params: JobParams,
  threadId: string | null,
  now: Date,
): Promise<ServiceResult<JobView>> {
  const id = randomFromAlphabet(ID_ALPHABET, 21)
  const idempotencyKey = params.kind === 'daily_cycle' ? dailyCycleIdempotencyKey(projectId, now) : null
  // The idempotency key is the only conflict target; a taken key returns no
  // row instead of raising, so the answer is a 409, never a 500.
  const [row] = await db
    .insert(jobs)
    .values({ id, tenantId, projectId, kind: params.kind, params, startedBy: origin, threadId, idempotencyKey, createdAt: now })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning(jobCols)
  if (!row) {
    return err(
      'CONFLICT',
      'The daily cycle already ran today for this project',
      'One daily cycle per project per UTC day. Start a single stage (discover / draft / evaluate) if more work is wanted today.',
    )
  }
  // The row exists before the instance so the Workflow always finds it. A
  // create failure removes the row again: nothing ran, and a daily cycle must
  // not hold the day's idempotency key after a transient binding outage.
  try {
    await runner.create(id, tenantId)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await db.delete(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    return err('INTERNAL_ERROR', 'Could not start the job', message)
  }
  return ok(toView(row))
}

export async function listJobs(
  db: Db,
  tenantId: TenantId,
  query: ListJobsQuery,
): Promise<ServiceResult<{ jobs: JobView[] }>> {
  const conditions = [eq(jobs.tenantId, tenantId)]
  if (query.projectId) {
    const resolved = await resolveProject(db, tenantId, query.projectId)
    if (!resolved.ok) return resolved
    conditions.push(eq(jobs.projectId, resolved.value))
  }
  if (query.threadId) conditions.push(eq(jobs.threadId, query.threadId))
  if (query.status) conditions.push(eq(jobs.status, query.status))
  if (query.kind) conditions.push(eq(jobs.kind, query.kind))
  const rows = await db
    .select(jobCols)
    .from(jobs)
    .where(and(...conditions))
    .orderBy(desc(jobs.createdAt))
    .limit(query.limit)
  return ok({ jobs: rows.map(toView) })
}

export async function getJob(db: Db, tenantId: TenantId, id: string): Promise<ServiceResult<JobView>> {
  const [row] = await db
    .select(jobCols)
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .limit(1)
  if (!row) return err('NOT_FOUND', 'Job not found')
  return ok(toView(row))
}

export async function cancelJob(
  db: Db,
  tenantId: TenantId,
  runner: JobRunner,
  id: string,
): Promise<ServiceResult<JobView>> {
  const current = await getJob(db, tenantId, id)
  if (!current.ok) return current
  if (TERMINAL_JOB_STATUSES.includes(current.value.status)) {
    return err('CONFLICT', `Job is already ${current.value.status}`)
  }
  // The row flips only once the instance cannot send anything further; a
  // running instance that could not be stopped keeps its row and its key.
  try {
    await runner.terminate(id)
  } catch (e) {
    return err('INTERNAL_ERROR', 'Could not stop the job', e instanceof Error ? e.message : String(e))
  }
  const [row] = await db
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: new Date(), idempotencyKey: null })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])))
    .returning(jobCols)
  return ok(row ? toView(row) : current.value)
}

// --- Workflow-side writes. Called on a raw connection (no RLS), so every
// predicate carries the tenant explicitly.

export type LoadedJob = JobView & { tenantId: TenantId }

export async function loadJobForRun(db: Db, tenantId: TenantId, id: string): Promise<LoadedJob | null> {
  const [row] = await db
    .select({ ...jobCols, tenantId: jobs.tenantId })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .limit(1)
  if (!row) return null
  return { ...toView(row), tenantId: asTenantId(row.tenantId) }
}

export async function markJobRunning(db: Db, tenantId: TenantId, id: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'running', startedAt: new Date() })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), eq(jobs.status, 'queued')))
}

export async function writeJobProgress(db: Db, tenantId: TenantId, id: string, progress: JobProgress): Promise<void> {
  await db.update(jobs).set({ progress }).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
}

export async function finishJob(
  db: Db,
  tenantId: TenantId,
  id: string,
  outcome: { ok: true; result: JobResult } | { ok: false; error: string },
): Promise<void> {
  // A cancelled job keeps its status even if the instance raced to finish.
  await db
    .update(jobs)
    .set(
      outcome.ok
        ? { status: 'succeeded', result: outcome.result, finishedAt: new Date() }
        : { status: 'failed', error: outcome.error, finishedAt: new Date(), idempotencyKey: null },
    )
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])))
}

// Cron entry: every project with the hosted cycle on whose hour is now gets
// today's daily_cycle job. Already-ran projects are skipped by the
// idempotency key, so the hourly cron may fire this freely.
export async function startDueDailyCycles(
  db: Db,
  runner: JobRunner,
  now: Date,
): Promise<{ started: number; skipped: number; failed: number }> {
  const hour = now.getUTCHours()
  const due = await db
    .select({
      projectId: projectSettings.projectId,
      tenantId: projectSettings.tenantId,
      outboundCount: projectSettings.hostedCycleOutboundCount,
    })
    .from(projectSettings)
    .innerJoin(projects, eq(projects.id, projectSettings.projectId))
    .where(and(eq(projectSettings.hostedCycleEnabled, true), eq(projectSettings.hostedCycleHourUtc, hour)))
  let started = 0
  let skipped = 0
  let failed = 0
  for (const p of due) {
    try {
      const result = await insertAndRun(
        db,
        asTenantId(p.tenantId),
        asProjectId(p.projectId),
        runner,
        'cron',
        { kind: 'daily_cycle', outboundCount: p.outboundCount },
        null,
        now,
      )
      if (result.ok) started++
      else if (result.code === 'CONFLICT') skipped++
      else failed++
    } catch (e) {
      console.error(`[jobs] daily cycle start failed project=${p.projectId}`, e)
      failed++
    }
  }
  return { started, skipped, failed }
}
