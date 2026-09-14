import type { Context } from 'hono'
import { kickAutoTopUp } from '../services/credits'
import type { Env, Variables } from './types'

// After a request that may have debited credits: top up in the background,
// after the response. The in-process chat dispatch passes the Worker's
// ExecutionContext through app.fetch, so waitUntil holds there too.
export function scheduleAutoTopUp(c: Context<{ Bindings: Env; Variables: Variables }>): void {
  c.executionCtx.waitUntil(kickAutoTopUp(c.env, c.get('tenantId')))
}
