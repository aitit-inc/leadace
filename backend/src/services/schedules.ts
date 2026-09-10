// Schedules: the saved instructions the hosted agent runs unattended. This
// service owns the rows; api/schedule-runner.ts owns what a due run does.
import { z } from 'zod'
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../db/connection'
import { projects, schedules } from '../db/schema'
import { asProjectId, asTenantId, projectRefSchema, type ProjectId, type TenantId } from '../domain/ids'
import {
  daysSchema,
  daysToMask,
  hourSchema,
  isDue,
  maskToDays,
  promptSchema,
  timezoneSchema,
  type DayOfWeek,
  MAX_CONSECUTIVE_FAILURES,
  MAX_SCHEDULES_PER_PROJECT,
} from '../domain/schedules'
import { randomFromAlphabet } from '../auth/random-id'
import { ok, err, type ServiceResult } from './result'
import { resolveProject } from './projects'

export const createScheduleBodySchema = z
  .object({
    projectId: projectRefSchema,
    prompt: promptSchema,
    timezone: timezoneSchema,
    hour: hourSchema,
    days: daysSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
export type CreateScheduleBody = z.infer<typeof createScheduleBodySchema>

export const updateScheduleBodySchema = z
  .object({
    prompt: promptSchema.optional(),
    timezone: timezoneSchema.optional(),
    hour: hourSchema.optional(),
    days: daysSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
export type UpdateScheduleBody = z.infer<typeof updateScheduleBodySchema>

export const listSchedulesQuerySchema = z.object({ projectId: projectRefSchema.optional() })
export type ListSchedulesQuery = z.infer<typeof listSchedulesQuerySchema>

export const scheduleIdParamSchema = z.object({ id: z.string().min(1).max(64) })

export type ScheduleView = {
  id: string
  projectId: ProjectId
  prompt: string
  timezone: string
  hour: number
  days: DayOfWeek[]
  enabled: boolean
  threadId: string | null
  lastRunAt: Date | null
  lastError: string | null
  consecutiveFailures: number
}

type ScheduleRow = typeof schedules.$inferSelect

function toView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    projectId: asProjectId(row.projectId),
    prompt: row.prompt,
    timezone: row.timezone,
    hour: row.hour,
    days: maskToDays(row.daysOfWeek),
    enabled: row.enabled,
    threadId: row.threadId,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    consecutiveFailures: row.consecutiveFailures,
  }
}

const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export async function listSchedules(
  db: Db,
  tenantId: TenantId,
  query: ListSchedulesQuery,
): Promise<ServiceResult<{ schedules: ScheduleView[] }>> {
  const conditions = [eq(schedules.tenantId, tenantId)]
  if (query.projectId) {
    const resolved = await resolveProject(db, tenantId, query.projectId)
    if (!resolved.ok) return resolved
    conditions.push(eq(schedules.projectId, resolved.value))
  }
  const rows = await db.select().from(schedules).where(and(...conditions)).orderBy(schedules.hour, schedules.id)
  return ok({ schedules: rows.map(toView) })
}

export async function createSchedule(
  db: Db,
  tenantId: TenantId,
  userId: string,
  body: CreateScheduleBody,
): Promise<ServiceResult<ScheduleView>> {
  const resolved = await resolveProject(db, tenantId, body.projectId)
  if (!resolved.ok) return resolved
  const projectId = resolved.value
  // Locking the project for the rest of the request serializes concurrent
  // creates, so the ceiling below cannot be raced past.
  await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update')
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schedules)
    .where(and(eq(schedules.tenantId, tenantId), eq(schedules.projectId, projectId)))
  if ((existing?.count ?? 0) >= MAX_SCHEDULES_PER_PROJECT) {
    return err(
      'FORBIDDEN',
      `A project can hold ${MAX_SCHEDULES_PER_PROJECT} schedules`,
      'Delete one before adding another.',
    )
  }
  const [row] = await db
    .insert(schedules)
    .values({
      id: randomFromAlphabet(ID_ALPHABET, 21),
      tenantId,
      projectId,
      userId,
      prompt: body.prompt,
      timezone: body.timezone,
      hour: body.hour,
      daysOfWeek: daysToMask(body.days),
      enabled: body.enabled,
    })
    .returning()
  if (!row) throw new Error('Invariant: schedule insert returned no row')
  return ok(toView(row))
}

export async function updateSchedule(
  db: Db,
  tenantId: TenantId,
  id: string,
  patch: UpdateScheduleBody,
): Promise<ServiceResult<ScheduleView>> {
  const [row] = await db
    .update(schedules)
    .set({
      ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
      ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      ...(patch.hour !== undefined ? { hour: patch.hour } : {}),
      ...(patch.days !== undefined ? { daysOfWeek: daysToMask(patch.days) } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      // Turning a stopped schedule back on clears the failures that stopped it.
      ...(patch.enabled === true ? { consecutiveFailures: 0, lastError: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
    .returning()
  if (!row) return err('NOT_FOUND', 'Schedule not found')
  return ok(toView(row))
}

export async function deleteSchedule(db: Db, tenantId: TenantId, id: string): Promise<ServiceResult<{ id: string }>> {
  const [row] = await db
    .delete(schedules)
    .where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
    .returning({ id: schedules.id })
  if (!row) return err('NOT_FOUND', 'Schedule not found')
  return ok(row)
}

// --- The cron path. Runs on a connection that bypasses RLS, so every query
// here carries its own tenant predicate or is deliberately cross-tenant.

export type DueSchedule = Omit<ScheduleRow, 'tenantId' | 'projectId'> & { tenantId: TenantId; projectId: ProjectId }

function toDue(row: ScheduleRow): DueSchedule {
  return { ...row, tenantId: asTenantId(row.tenantId), projectId: asProjectId(row.projectId) }
}

// The zone is per row, so the local hour cannot be a SQL predicate; the set is
// small (a handful per tenant) and the rule is the pure one in domain.
export async function listDueSchedules(db: Db, now: Date): Promise<DueSchedule[]> {
  const rows = await db.select().from(schedules).where(eq(schedules.enabled, true))
  return rows.filter((r) => isDue(r, now)).map(toDue)
}

// The claim IS the concurrency control: one conditional update moves the row's
// key to this hour, so a second cron firing finds nothing to take. It answers
// with the row as of the claim — the instruction that runs is the newest one,
// while the recurrence is pinned to the one that was scanned, because a key
// derived from a zone the person has since changed no longer names this hour.
export async function claimScheduleRun(db: Db, scanned: DueSchedule, runKey: string, now: Date): Promise<DueSchedule | null> {
  const [claimed] = await db
    .update(schedules)
    .set({ lastRunKey: runKey, lastRunAt: now })
    .where(
      and(
        eq(schedules.tenantId, scanned.tenantId),
        eq(schedules.id, scanned.id),
        eq(schedules.enabled, true),
        eq(schedules.timezone, scanned.timezone),
        eq(schedules.hour, scanned.hour),
        eq(schedules.daysOfWeek, scanned.daysOfWeek),
        sql`${schedules.lastRunKey} IS DISTINCT FROM ${runKey}`,
      ),
    )
    .returning()
  return claimed ? toDue(claimed) : null
}

export async function attachScheduleThread(db: Db, tenantId: TenantId, id: string, threadId: string): Promise<void> {
  await db.update(schedules).set({ threadId }).where(and(eq(schedules.tenantId, tenantId), eq(schedules.id, id)))
}

// `error` null = the run succeeded. Answers whether this outcome stopped the
// schedule.
export async function recordScheduleOutcome(
  db: Db,
  tenantId: TenantId,
  id: string,
  error: string | null,
): Promise<boolean> {
  const row = and(eq(schedules.tenantId, tenantId), eq(schedules.id, id))
  if (error === null) {
    await db.update(schedules).set({ lastError: null, consecutiveFailures: 0 }).where(row)
    return false
  }
  const [updated] = await db
    .update(schedules)
    .set({
      lastError: error.slice(0, 500),
      consecutiveFailures: sql`${schedules.consecutiveFailures} + 1`,
      // Reads the row's own `enabled`, so a person who turned it off mid-run
      // is not overruled by the failure that lands after them.
      enabled: sql`${schedules.enabled} AND ${schedules.consecutiveFailures} + 1 < ${MAX_CONSECUTIVE_FAILURES}`,
    })
    .where(row)
    .returning({ enabled: schedules.enabled })
  return updated?.enabled === false
}
