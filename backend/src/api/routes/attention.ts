import { Hono } from 'hono'
import { listTenantAttention } from '../../services/attention'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const attentionRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

attentionRouter.get('/me/attention', async (c) => {
  const result = await listTenantAttention(
    c.get('db'),
    c.get('tenantId'),
    c.get('userId'),
    c.get('edition'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json({ items: result.value })
})
