// Jobs: the one way hosted-agent work is started, whoever asks (cron, chat,
// Web UI, MCP). A row is the record; the Workflow instance with the same id
// does the work (jobs/workflow.ts) and reports back through the row.
import { z } from 'zod'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import type { TenantRun } from '../db/rls'
import { jobs, projects } from '../db/schema'
import type { ProjectId, ProjectRef, TenantId } from '../domain/ids'
import { asProjectId, asTenantId, projectRefSchema } from '../domain/ids'
import {
  JOB_KINDS,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  jobParamsSchema,
  type JobKind,
  type JobLogEntry,
  type JobLogLine,
  type JobOrigin,
  type JobParams,
  type JobProgress,
  type JobResult,
  type JobStatus,
} from '../domain/jobs'
import { randomFromAlphabet } from '../auth/random-id'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'
import { getActiveStrategySlugs } from './discovery-strategies'
import { notify, type NotifyCtx, type NotifyResult } from './notifications'
import { categoryOfJob } from '../domain/notifications'

// The Workflow binding, narrowed to what this service needs so it stays
// testable and free of the Worker env type.
export type JobRunner = {
  create: (jobId: string, tenantId: TenantId) => Promise<void>
  // True once the instance can no longer act (finished, errored, terminated,
  // or gone) — a row still in flight then belongs to nothing.
  settled: (jobId: string) => Promise<boolean>
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
  logEntries: number
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
  logEntries: sql<number>`jsonb_array_length(${jobs.log})`,
}

// The log grows with the work, so only the single-job read carries it.
export type JobDetail = JobView & { log: JobLogLine[] }

function toView(row: Omit<JobView, 'projectId'> & { projectId: string }): JobView {
  return { ...row, projectId: asProjectId(row.projectId) }
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

// Must read the same as the uq_jobs_daily_cycle_in_flight predicate: the
// insert infers that index from it.
const dailyCycleInFlightExpr = sql`${jobs.kind} = 'daily_cycle' AND ${jobs.status} IN ('queued', 'running')`

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
  // A conflict returns no row instead of raising, so a second daily cycle is
  // a 409, never a 500.
  const insert = () =>
    db
      .insert(jobs)
      .values({ id, tenantId, projectId, kind: params.kind, params, startedBy: origin, threadId, createdAt: now })
      .onConflictDoNothing({ target: [jobs.projectId], where: dailyCycleInFlightExpr })
      .returning(jobCols)
  let [row] = await insert()
  if (!row) {
    // A Workflow that died before finishJob (retries exhausted, DB outage)
    // leaves its row in flight; the next start is where that is noticed.
    const blocking = await inFlightDailyCycle(db, tenantId, projectId)
    if (blocking && (await runner.settled(blocking.id))) {
      await releaseJob(db, tenantId, blocking.id, now)
      ;[row] = await insert()
    }
  }
  if (!row) {
    const running = await inFlightDailyCycle(db, tenantId, projectId)
    const which = running ? ` Job ${running.id}, ${running.status}, started by ${running.startedBy} at ${running.createdAt.toISOString()}.` : ''
    return err(
      'CONFLICT',
      'A daily cycle is already running for this project',
      `Wait for it to finish (get_job), or cancel it first.${which}`,
    )
  }
  // The row exists before the instance so the Workflow always finds it. A
  // create failure removes the row again: nothing ran, and a daily cycle must
  // not hold the in-flight lock after a transient binding outage.
  try {
    await runner.create(id, tenantId)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await db.delete(jobs).where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    return err('INTERNAL_ERROR', 'Could not start the job', message)
  }
  return ok(toView(row))
}

async function inFlightDailyCycle(db: Db, tenantId: TenantId, projectId: ProjectId) {
  const [row] = await db
    .select(jobCols)
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.projectId, projectId), dailyCycleInFlightExpr))
    .limit(1)
  return row
}

async function releaseJob(db: Db, tenantId: TenantId, id: string, now: Date): Promise<void> {
  await db
    .update(jobs)
    .set({ status: 'failed', error: 'The Workflow instance ended without reporting back', finishedAt: now })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])))
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

export async function getJob(db: Db, tenantId: TenantId, id: string): Promise<ServiceResult<JobDetail>> {
  const [row] = await db
    .select({ ...jobCols, log: jobs.log })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .limit(1)
  if (!row) return err('NOT_FOUND', 'Job not found')
  const { log, ...view } = row
  return ok({ ...toView(view), log })
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
  // The row flips only once the instance cannot send anything further; one
  // that could not be stopped keeps its row, and with it the in-flight lock.
  try {
    await runner.terminate(id)
  } catch (e) {
    return err('INTERNAL_ERROR', 'Could not stop the job', e instanceof Error ? e.message : String(e))
  }
  const [row] = await db
    .update(jobs)
    .set({ status: 'cancelled', finishedAt: new Date() })
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

// Reads the row, not the run's outcome: a job cancelled while it ran ends
// quietly, whatever the run returned.
export async function notifyJobFinished(run: TenantRun, tenantId: TenantId, ctx: NotifyCtx, id: string): Promise<ServiceResult<NotifyResult>> {
  const [row] = await run((db) => db
    .select({ kind: jobs.kind, status: jobs.status, result: jobs.result, error: jobs.error, startedBy: jobs.startedBy, threadId: jobs.threadId, project: projects.name })
    .from(jobs)
    .innerJoin(projects, eq(projects.id, jobs.projectId))
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id)))
    .limit(1))
  if (!row) return err('NOT_FOUND', `Job ${id} not found`)
  if (row.status !== 'succeeded' && row.status !== 'failed') return ok({ emailedTo: null })
  return notify(run, tenantId, ctx, {
    category: categoryOfJob(row.startedBy),
    reference: `job:${id}`,
    subject: `${row.kind.replace('_', ' ')} ${row.status}: ${row.project}`,
    body: (row.status === 'succeeded' ? row.result?.summary : row.error) ?? row.status,
    link: row.threadId ? `/chat?t=${row.threadId}` : '/chat',
  })
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

// A step that runs again after writing (the instance restarted before the
// step was recorded as done) finds its lines already there.
export async function appendJobLog(db: Db, tenantId: TenantId, id: string, step: string, entries: JobLogEntry[]): Promise<void> {
  const at = new Date().toISOString()
  const lines: JobLogLine[] = entries.map((e) => ({ ...e, at, step }))
  await db
    .update(jobs)
    .set({ log: sql`${jobs.log} || ${JSON.stringify(lines)}::jsonb` })
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), sql`NOT ${jobs.log} @> ${JSON.stringify([{ step }])}::jsonb`))
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
        : { status: 'failed', error: outcome.error, finishedAt: new Date() },
    )
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, id), inArray(jobs.status, ['queued', 'running'])))
}

