import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  applyStrategyDraft,
  applyStrategyDraftSchema,
  competitorCandidates,
  competitorsInputSchema,
  readPagesSchema,
  readSharedPages,
  setupGuide,
} from '../../services/pipeline/strategy-draft'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const strategyDraftRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

strategyDraftRouter.post('/me/setup/pages', zValidator('json', readPagesSchema), async (c) => {
  const result = await readSharedPages(c.get('db'), c.get('tenantId'), c.req.valid('json').urls)
  if (!result.ok) return respondWithError(c, result)
  return c.json({ pages: result.value })
})

strategyDraftRouter.get('/me/setup/guide', async (c) => {
  return c.json({ guide: await setupGuide(c.get('db'), c.get('tenantId')) })
})

strategyDraftRouter.post('/me/setup/competitors', zValidator('json', competitorsInputSchema), async (c) => {
  const result = await competitorCandidates(c.get('db'), c.get('tenantId'), c.env, c.req.valid('json').url)
  if (!result.ok) return respondWithError(c, result)
  return c.json({ competitors: result.value })
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
