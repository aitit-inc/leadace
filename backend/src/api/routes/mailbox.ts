import { Hono } from 'hono'
import { getProjectMailboxHealth, replaceProjectMailboxes, replaceProjectMailboxesSchema } from '../../services/mailbox'
import { projectRefParamSchema } from '../../domain/ids'
import { zValidator } from '../zvalidator'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const mailboxRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// Available on every edition — the per-mailbox daily cap is a deliverability
// guardrail, not a billing gate. `no_mailbox` is a normal state, not an error,
// so the service returns it as a plain ok value.
mailboxRouter.get(
  '/projects/:id/mailbox-health',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await getProjectMailboxHealth(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    return result.ok ? c.json(result.value) : respondWithError(c, result)
  },
)

// Which mailboxes a project sends from, in priority order. Not caller-gated:
// the chat reaches it only through set_project_mailboxes, an approval-card tool.
mailboxRouter.put(
  '/projects/:id/mailboxes',
  zValidator('param', projectRefParamSchema),
  zValidator('json', replaceProjectMailboxesSchema),
  async (c) => {
    const result = await replaceProjectMailboxes(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value) : respondWithError(c, result)
  },
)
