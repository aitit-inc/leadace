import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  listResponsesQuerySchema,
  rejectionFeedbackSummaryQuerySchema,
  recordResponse,
  recordResponseSchema,
  listProjectResponses,
  getRejectionFeedbackSummary,
} from '../../services/responses'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const responsesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

responsesRouter.post('/responses', zValidator('json', recordResponseSchema), async (c) => {
  const result = await recordResponse(c.get('db'), c.get('tenantId'), c.req.valid('json'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 201)
})

responsesRouter.get(
  '/projects/:id/responses',
  zValidator('param', projectRefParamSchema),
  zValidator('query', listResponsesQuerySchema),
  async (c) => {
    const result = await listProjectResponses(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

responsesRouter.get(
  '/projects/:id/rejection-feedback/summary',
  zValidator('param', projectRefParamSchema),
  zValidator('query', rejectionFeedbackSummaryQuerySchema),
  async (c) => {
    const result = await getRejectionFeedbackSummary(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
