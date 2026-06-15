import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { getDashboardSummary, dashboardQuerySchema } from '../../services/dashboard'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const dashboardRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

dashboardRouter.get(
  '/projects/:id/dashboard',
  zValidator('param', projectRefParamSchema),
  zValidator('query', dashboardQuerySchema),
  async (c) => {
    const result = await getDashboardSummary(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.get('edition'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
