// The hourly cron's schedule half: run every schedule due this local hour as
// one unattended agent turn.
//
// The turn is short — it reads, it starts jobs, it reports — and the work it
// starts is durable on its own (a job is a Workflow instance), so the run
// lives inside the cron invocation instead of needing durability of its own.
// That holds while the schedules due in one hour stay in the dozens; past
// that the turn moves onto the Workflow the jobs already use.
import { SignJWT } from 'jose'
import * as Sentry from '@sentry/cloudflare'
import type { Db } from '../db/connection'
import { withTenantConnection } from '../db/rls'
import { runKey } from '../domain/schedules'
import { runChatTurn } from '../services/chat/agent'
import { unattendedTools } from '../services/chat/unattended'
import { createThread, titleFromMessage } from '../services/chat/threads'
import { notifyUser } from '../services/notifications'
import { googleCtxOf } from '../services/pipeline/context'
import {
  attachScheduleThread,
  claimScheduleRun,
  listDueSchedules,
  recordScheduleOutcome,
  type DueSchedule,
} from '../services/schedules'
import { buildToolExecutor, type InternalDispatch } from './tool-executor'
import type { Env } from './types'

// Long enough for one turn's tool calls, short enough to be worthless if it
// ever escaped the isolate.
const RUN_TOKEN_TTL_SECONDS = 900
// Turns are network-bound and the cron invocation is not unlimited; a few at a
// time keeps a slow model call from starving the rest of the hour's schedules.
const CONCURRENCY = 5

type ScheduleRunSummary = { due: number; ran: number; failed: number; skipped: number }

// The run acts as the person who registered the schedule. Signed with the same
// secret the API already accepts (auth/verify-jwt HS256 path), never leaves
// this Worker, and carries no audience — it is not an MCP token.
async function mintRunToken(userId: string, jwtSecret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + RUN_TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(jwtSecret))
}

async function runOne(env: Env, ctx: ExecutionContext, dispatch: InternalDispatch, schedule: DueSchedule): Promise<void> {
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

  const authorization = `Bearer ${await mintRunToken(schedule.userId, env.SUPABASE_JWT_SECRET)}`
  const deps = {
    run,
    aborted: () => false,
    tenantId: schedule.tenantId,
    userId: schedule.userId,
    env,
    tools: unattendedTools(buildToolExecutor(env, ctx, dispatch, { origin: 'cron', authorization, apiOrigin: env.API_URL })),
    unattended: true,
  }

  let failure: string | null = null
  for await (const event of runChatTurn(deps, threadId, { kind: 'message', text: schedule.prompt })) {
    if (event.type === 'error') failure = event.message
  }
  const stopped = await run((db) => recordScheduleOutcome(db, schedule.tenantId, schedule.id, failure))
  if (stopped) {
    await run((db) =>
      notifyUser(db, schedule.tenantId, schedule.userId, googleCtxOf(env), {
        subject: 'A LeadAce schedule stopped',
        body: `The scheduled run "${schedule.prompt}" failed three times in a row and is now off.\n\nLast error: ${failure ?? 'unknown'}\n\nTurn it back on from the project settings page once the cause is fixed: ${env.APP_URL}/project-settings`,
      }),
    )
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
      try {
        await runOne(env, ctx, dispatch, claimed)
        summary.ran++
      } catch (e) {
        summary.failed++
        console.error(`[schedules] run failed schedule=${schedule.id}`, e)
        Sentry.captureException(e)
        const error = e instanceof Error ? e.message : String(e)
        await recordScheduleOutcome(db, schedule.tenantId, schedule.id, error).catch((err: unknown) =>
          console.error(`[schedules] outcome write failed schedule=${schedule.id}`, err),
        )
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, summary.due) }, worker))
  return summary
}
