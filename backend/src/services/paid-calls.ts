import { AsyncLocalStorage } from 'node:async_hooks'
import type { Db } from '../db/connection'
import { withTenantConnection } from '../db/rls'
import { paidCalls } from '../db/schema'
import type { ProjectId, TenantId } from '../domain/ids'
import type { PaidCall } from '../domain/paid-calls'

export type PaidCallFor = { projectId?: ProjectId; jobId?: string; threadId?: string }

// Who the paid calls made under it are for. The call site does not know; the
// entry point that serves the tenant (a job step, a chat turn, a request) does.
export type PaidCallScope = PaidCallFor & { databaseUrl: string; tenantId: TenantId }
const paidCallScope = new AsyncLocalStorage<PaidCallScope>()

// An enclosing scope wins: a chat turn's tool calls re-enter the API in
// process, and the request must not lose the thread they were made for.
export function withPaidCallScope<T>(scope: PaidCallScope, fn: () => Promise<T>): Promise<T> {
  return paidCallScope.getStore() ? fn() : paidCallScope.run(scope, fn)
}

export function currentPaidCallScope(): Partial<Omit<PaidCallScope, 'databaseUrl'>> {
  const { tenantId, projectId, jobId, threadId } = paidCallScope.getStore() ?? {}
  return { tenantId, projectId, jobId, threadId }
}

export async function insertPaidCall(db: Db, tenantId: TenantId, paidFor: PaidCallFor, call: PaidCall): Promise<void> {
  await db.insert(paidCalls).values({
    tenantId,
    projectId: paidFor.projectId ?? null,
    jobId: paidFor.jobId ?? null,
    threadId: paidFor.threadId ?? null,
    op: call.op,
    model: call.model,
    tier: call.tier,
    inputTokens: call.usage.input,
    cachedInputTokens: call.usage.cachedInput,
    cacheWriteTokens: call.usage.cacheWrite,
    outputTokens: call.usage.output,
    reasoningTokens: call.usage.thoughts,
    searchCalls: call.usage.searchCalls,
  })
}

// The paid call's caller waits at most this long; a slower write goes on
// without it, so the ledger never adds to a call's deadline.
const RECORD_WAIT_MS = 5_000

// On its own connection, so the call is kept whatever becomes of the work
// that paid for it. A failed write is logged, never thrown: the call is
// already paid for.
export async function recordPaidCall(call: PaidCall): Promise<void> {
  const scope = paidCallScope.getStore()
  if (!scope) {
    console.error(`[paid-calls] ${call.op} ran outside a scope — not recorded`)
    return
  }
  const write = withTenantConnection(scope.databaseUrl, scope.tenantId, (db) => insertPaidCall(db, scope.tenantId, scope, call)).catch((e: unknown) =>
    console.error(`[paid-calls] ${call.op} not recorded tenant=${scope.tenantId}`, e),
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[paid-calls] ${call.op} still writing after ${RECORD_WAIT_MS}ms tenant=${scope.tenantId}`)
      resolve()
    }, RECORD_WAIT_MS)
  })
  await Promise.race([write, waited])
  clearTimeout(timer)
}
