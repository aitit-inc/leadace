import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  dismissSuggestion,
  dismissSuggestionBodySchema,
  listSuggestions,
  listSuggestionsQuerySchema,
  recordSuggestion,
  recordSuggestionBodySchema,
} from '../../services/suggestions'
import { projectRefParamSchema } from '../../services/projects'
import { suggestionIdParamSchema } from '../../domain/ids'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const suggestionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

suggestionsRouter.get(
  '/projects/:id/suggestions',
  zValidator('param', projectRefParamSchema),
  zValidator('query', listSuggestionsQuerySchema),
  async (c) => {
    const result = await listSuggestions(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

suggestionsRouter.post(
  '/projects/:id/suggestions',
  zValidator('param', projectRefParamSchema),
  zValidator('json', recordSuggestionBodySchema),
  async (c) => {
    const result = await recordSuggestion(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value, 201)
  },
)

suggestionsRouter.patch(
  '/suggestions/:id',
  zValidator('param', suggestionIdParamSchema),
  zValidator('json', dismissSuggestionBodySchema),
  async (c) => {
    const result = await dismissSuggestion(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
