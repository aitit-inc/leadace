// The hourly cron's schedule half: run every schedule due this local hour as
// one unattended agent turn.
//
// The turn is short — it reads, it starts jobs, it reports — and the work it
// starts is durable on its own (a job is a Workflow instance), so the run
// lives inside the cron invocation instead of needing durability of its own.
// That holds while the schedules due in one hour stay in the dozens; past
// that the turn moves onto the Workflow the jobs already use.
import * as Sentry from '@sentry/cloudflare'
import type { Db } from '../db/connection'
import { withTenantConnection, type TenantRun } from '../db/rls'
import { runKey } from '../domain/schedules'
import { runChatTurn } from '../services/chat/agent'
import { withLlmScope } from '../services/llm'
import { unattendedTools } from '../services/chat/unattended'
import { appendMessage, createThread, titleFromMessage } from '../services/chat/threads'
import { notify, notifyCtxOf } from '../services/notifications'
import {
  attachScheduleThread,
  claimScheduleRun,
  listDueSchedules,
  recordScheduleOutcome,
  type DueSchedule,
} from '../services/schedules'
import { buildToolExecutor, type InternalDispatch } from './tool-executor'
import type { Env } from './types'

// Turns are network-bound and the cron invocation is not unlimited; a few at a
// time keeps a slow model call from starving the rest of the hour's schedules.
const CONCURRENCY = 5

type ScheduleRunSummary = { due: number; ran: number; failed: number; skipped: number }

async function runOne(env: Env, ctx: ExecutionContext, dispatch: InternalDispatch, schedule: DueSchedule): Promise<string | null> {
  const run = <T>(fn: (db: Db) => Promise<T>) => withTenantConnection(env.DATABASE_URL, schedule.tenantId, fn)
  // One thread per schedule: the person reads every run of it in one place,
  // and the job notices come back there.
  const threadId =
    schedule.threadId ??
    (await run(async (db) => {
      const created = await createThread(db, schedule.tenantId, {
        projectId: schedule.projectId,
        title: `Scheduled: ${titleFromMessage(schedule.prompt)}`,
      })
      if (!created.ok) throw new Error(`thread create failed: ${created.error}`)
      await attachScheduleThread(db, schedule.tenantId, schedule.id, created.value.id)
      return created.value.id
    }))

  // Read where it lands: this run answers it, the thread runner does not.
  const instruction = await run((db) => appendMessage(db, schedule.tenantId, threadId, { role: 'user', parts: [{ text: schedule.prompt }] }))
  const deps = {
    run,
    signal: new AbortController().signal,
    tenantId: schedule.tenantId,
    // The run acts as the person who registered the schedule.
    userId: schedule.userId,
    env,
    tools: unattendedTools(buildToolExecutor(env, ctx, dispatch, { origin: 'cron', userId: schedule.userId })),
  }

  let failure: string | null = null
  await withLlmScope({ tenantId: schedule.tenantId, threadId }, async () => {
    for await (const event of runChatTurn(deps, threadId, { kind: 'instruction', message: instruction })) {
      if (event.type === 'error') failure = event.message
    }
  })
  return failure
}

async function recordOutcome(env: Env, schedule: DueSchedule, failure: string | null): Promise<void> {
  const run: TenantRun = (fn) => withTenantConnection(env.DATABASE_URL, schedule.tenantId, fn)
  // Committed on its own: a failed notification must not undo the failure count.
  const stopped = await run((db) => recordScheduleOutcome(db, schedule.tenantId, schedule.id, failure))
  if (failure === null) return
  try {
    const r = await notify(run, schedule.tenantId, notifyCtxOf(env), {
      category: 'cron',
      reference: `schedule:${schedule.id}:${schedule.lastRunKey}`,
      subject: stopped ? 'A LeadAce schedule failed and is now off' : 'A LeadAce scheduled run failed',
      body: `Scheduled run: "${schedule.prompt}"\n\nError: ${failure}${stopped ? '\n\nIt failed three times in a row, so it is off. Turn it back on from the project settings page once the cause is fixed.' : ''}`,
      link: '/project-settings',
    })
    if (!r.ok) console.warn(`[schedules] notification failed schedule=${schedule.id}: ${r.error}`)
  } catch (e) {
    console.warn(`[schedules] notification failed schedule=${schedule.id}`, e)
  }
}

export async function runDueSchedules(
  db: Db,
  env: Env,
  ctx: ExecutionContext,
  dispatch: InternalDispatch,
  now: Date,
): Promise<ScheduleRunSummary> {
  const due = await listDueSchedules(db, now)
  const summary: ScheduleRunSummary = { due: due.length, ran: 0, failed: 0, skipped: 0 }
  const worker = async (): Promise<void> => {
    for (let schedule = due.shift(); schedule; schedule = due.shift()) {
      // The claim decides who runs this hour, and what it hands back is what
      // runs: an instruction edited since the scan is the person's latest word,
      // while a schedule moved to another hour is left to the scan that finds
      // it there.
      const claimed = await claimScheduleRun(db, schedule, runKey(schedule.timezone, now), now)
      if (!claimed) {
        summary.skipped++
        continue
      }
      let failure: string | null
      try {
        failure = await runOne(env, ctx, dispatch, claimed)
        summary.ran++
      } catch (e) {
        summary.failed++
        console.error(`[schedules] run failed schedule=${schedule.id}`, e)
        Sentry.captureException(e)
        failure = e instanceof Error ? e.message : String(e)
      }
      await recordOutcome(env, claimed, failure).catch((err: unknown) =>
        console.error(`[schedules] outcome write failed schedule=${schedule.id}`, err),
      )
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, summary.due) }, worker))
  return summary
}
