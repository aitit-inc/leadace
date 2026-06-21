import { Hono } from 'hono'
import {
  getMailboxHealth,
  updateMailboxWarmup,
  updateMailboxWarmupSchema,
} from '../../services/plan-limits'
import { zValidator } from '../zvalidator'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const mailboxRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /me/mailbox-health — warmup / per-mailbox daily-cap state for the tenant's
// sending mailbox. Read-only; available on every edition (the cap is a
// deliverability guardrail, not a billing gate). `no_mailbox` is a normal state,
// not an error, so the service returns a plain value the route ships verbatim.
mailboxRouter.get('/me/mailbox-health', async (c) => {
  const health = await getMailboxHealth(c.get('db'), c.get('tenantId'))
  return c.json(health)
})

mailboxRouter.put(
  '/me/mailbox-warmup',
  zValidator('json', updateMailboxWarmupSchema),
  async (c) => {
    const result = await updateMailboxWarmup(c.get('db'), c.get('tenantId'), c.req.valid('json'))
    return result.ok ? c.json(result.value) : respondWithError(c, result)
  },
)
