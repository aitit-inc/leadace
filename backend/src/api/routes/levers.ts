import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  runLeverTick,
  getLeverState,
  getLeverDecisionsHistory,
  leverDecisionsHistoryQuerySchema,
} from '../../services/levers'
import { projectIdParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const leversRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

leversRouter.post(
  '/projects/:id/run-lever-tick',
  zValidator('param', projectIdParamSchema),
  async (c) => {
    const result = await runLeverTick(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

leversRouter.get(
  '/projects/:id/lever-state',
  zValidator('param', projectIdParamSchema),
  async (c) => {
    const result = await getLeverState(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

leversRouter.get(
  '/projects/:id/lever-decisions',
  zValidator('param', projectIdParamSchema),
  zValidator('query', leverDecisionsHistoryQuerySchema),
  async (c) => {
    const result = await getLeverDecisionsHistory(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query').days,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
