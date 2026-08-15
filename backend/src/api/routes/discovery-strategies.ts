import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  upsertDiscoveryStrategyBodySchema,
  listDiscoveryStrategies,
  upsertDiscoveryStrategy,
} from '../../services/discovery-strategies'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const discoveryStrategiesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

discoveryStrategiesRouter.get(
  '/projects/:id/discovery-strategies',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await listDiscoveryStrategies(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

discoveryStrategiesRouter.put(
  '/projects/:id/discovery-strategies',
  zValidator('param', projectRefParamSchema),
  zValidator('json', upsertDiscoveryStrategyBodySchema),
  async (c) => {
    const result = await upsertDiscoveryStrategy(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
