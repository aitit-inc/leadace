import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '../zvalidator'
import {
  upsertVariantBodySchema,
  listMessageVariants,
  upsertMessageVariant,
  pickMessageVariant,
} from '../../services/message-variants'
import { projectRefParamSchema } from '../../services/projects'
import { variantIdSchema } from '../../domain/ids'
import { respondWithError } from '../respond'
import { err } from '../../services/result'
import type { Env, Variables } from '../types'

export const messageVariantsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

messageVariantsRouter.get(
  '/projects/:id/message-variants',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await listMessageVariants(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

messageVariantsRouter.put(
  '/projects/:id/message-variants',
  zValidator('param', projectRefParamSchema),
  zValidator('json', upsertVariantBodySchema),
  async (c) => {
    const result = await upsertMessageVariant(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

const pickQuerySchema = z.object({
  variantId: variantIdSchema.optional(),
})

// POST, not GET: the pick is a weighted random draw, so each call may return a
// different variant — a cacheable GET would be wrong.
messageVariantsRouter.post(
  '/projects/:id/message-variants/pick',
  zValidator('param', projectRefParamSchema),
  zValidator('query', pickQuerySchema),
  async (c) => {
    const { id: projectId } = c.req.valid('param')
    const { variantId } = c.req.valid('query')
    const result = await pickMessageVariant(
      c.get('db'),
      c.get('tenantId'),
      projectId,
      variantId,
    )
    if (!result.ok) return respondWithError(c, result)
    if (!result.value) {
      return respondWithError(
        c,
        err(
          'NOT_FOUND',
          'No active message variants',
          'Register at least one message variant on this project before requesting a pick.',
        ),
      )
    }
    return c.json(result.value)
  },
)
