import { Hono } from 'hono'
import { z } from 'zod'
import { zValidator } from '../zvalidator'
import {
  upsertVariantBodySchema,
  listSubjectVariants,
  upsertSubjectVariant,
  pickSubjectVariant,
} from '../../services/subject-variants'
import { projectIdParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import { err } from '../../services/result'
import type { Env, Variables } from '../types'

export const subjectVariantsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

subjectVariantsRouter.get(
  '/projects/:id/subject-variants',
  zValidator('param', projectIdParamSchema),
  async (c) => {
    const result = await listSubjectVariants(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

subjectVariantsRouter.put(
  '/projects/:id/subject-variants',
  zValidator('param', projectIdParamSchema),
  zValidator('json', upsertVariantBodySchema),
  async (c) => {
    const result = await upsertSubjectVariant(
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
  variantId: z.string().min(1).max(32).optional(),
})

// POST so cursor advance is not idempotent (a GET that mutates state would
// confuse caches and pre-fetchers). The skill calls this once per send to
// learn which variant + pattern to render before composing the subject.
subjectVariantsRouter.post(
  '/projects/:id/subject-variants/pick',
  zValidator('param', projectIdParamSchema),
  zValidator('query', pickQuerySchema),
  async (c) => {
    const { id: projectId } = c.req.valid('param')
    const { variantId } = c.req.valid('query')
    const result = await pickSubjectVariant(
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
          'No active subject variants',
          'Register at least one subject variant on this project before requesting a pick.',
        ),
      )
    }
    return c.json(result.value)
  },
)
