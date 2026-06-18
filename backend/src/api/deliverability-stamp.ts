import type { Context } from 'hono'
import { stampEmailDeliverability } from '../services/dns-check'
import type { Env, Variables } from './types'

// Resolve email deliverability off the request path (ctx.waitUntil), so the DNS
// lookups never run inside the request's RLS transaction. Best-effort.
export function scheduleDeliverabilityStamp(
  c: Context<{ Bindings: Env; Variables: Variables }>,
  emails: readonly string[],
): void {
  if (emails.length === 0) return
  c.executionCtx.waitUntil(
    stampEmailDeliverability(c.env.DATABASE_URL, c.get('tenantId'), emails),
  )
}
