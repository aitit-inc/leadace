import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { z } from 'zod'
import { getProjectStats } from '../../services/loop/observe'
import { getHistory } from '../../services/loop/history'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const evaluationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

const historyQuerySchema = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() })

evaluationsRouter.get(
  '/projects/:id/history',
  zValidator('param', projectRefParamSchema),
  zValidator('query', historyQuerySchema),
  async (c) => {
    const result = await getHistory(c.get('db'), c.get('tenantId'), c.req.valid('param').id, c.req.valid('query').days ?? null)
    if (!result.ok) return respondWithError(c, result)
    return c.json({ rows: result.value })
  },
)

evaluationsRouter.get(
  '/projects/:id/stats',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await getProjectStats(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
