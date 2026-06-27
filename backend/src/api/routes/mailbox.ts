import { Hono } from 'hono'
import { getProjectMailboxHealth } from '../../services/mailbox'
import { projectRefParamSchema } from '../../domain/ids'
import { zValidator } from '../zvalidator'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const mailboxRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /projects/:id/mailbox-health — warmup / per-mailbox daily-cap state of the
// mailbox THIS project sends from (resolves the project's sending identity, else
// the connected Gmail). Read-only; available on every edition (the cap is a
// deliverability guardrail, not a billing gate). `no_mailbox` is a normal state,
// not an error, so the service returns a plain value the route ships verbatim.
mailboxRouter.get(
  '/projects/:id/mailbox-health',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await getProjectMailboxHealth(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    return result.ok ? c.json(result.value) : respondWithError(c, result)
  },
)
