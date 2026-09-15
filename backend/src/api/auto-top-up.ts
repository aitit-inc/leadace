import type { Context } from 'hono'
import { kickAutoTopUp } from '../services/credits'
import type { Env, Variables } from './types'

// After a request that may have debited credits: top up in the background,
// after the response. A chat turn's tool call hands it to the thread runner,
// which holds the turn open until it settles.
export function scheduleAutoTopUp(c: Context<{ Bindings: Env; Variables: Variables }>): void {
  c.executionCtx.waitUntil(kickAutoTopUp(c.env, c.get('tenantId')))
}
