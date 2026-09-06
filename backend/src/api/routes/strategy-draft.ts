import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  draftStrategyFromUrl,
  applyStrategyDraft,
  strategyDraftInputSchema,
  applyStrategyDraftSchema,
} from '../../services/pipeline/strategy-draft'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const strategyDraftRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

strategyDraftRouter.post('/me/strategy-draft', zValidator('json', strategyDraftInputSchema), async (c) => {
  const result = await draftStrategyFromUrl(c.get('db'), c.get('tenantId'), c.env, c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

strategyDraftRouter.post(
  '/projects/:id/strategy-draft/apply',
  zValidator('param', projectRefParamSchema),
  zValidator('json', applyStrategyDraftSchema),
  async (c) => {
    const result = await applyStrategyDraft(c.get('db'), c.get('tenantId'), c.env, c.req.valid('param').id, c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
