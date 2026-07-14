import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { getProjectStats } from '../../services/evaluations'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const evaluationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

evaluationsRouter.get(
  '/projects/:id/stats',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await getProjectStats(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
