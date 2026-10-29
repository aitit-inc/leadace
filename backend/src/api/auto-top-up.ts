import type { Context } from 'hono'
import { kickAutoTopUp } from '../services/credits'
import type { Env, Variables } from './types'

// After a request that may have debited credits: top up in the background,
// after the response. The top-up reads the balance on its own connection, so
// under rlsMiddleware it starts only once the debit has committed. A chat
// turn's tool call hands it to the thread runner, which holds the turn open
// until it settles.
export function scheduleAutoTopUp(c: Context<{ Bindings: Env; Variables: Variables }>): void {
  const tenantId = c.get('tenantId')
  const kick = () => kickAutoTopUp(c.env, tenantId)
  const afterCommit = c.get('afterCommit')
  if (afterCommit) afterCommit.push(kick)
  else c.executionCtx.waitUntil(kick())
}
