import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  prospectIdParamSchema,
  reachableQuerySchema,
  listProjectProspectsQuerySchema,
  listTenantProspectsQuerySchema,
  updateProspectStatusBodySchema,
  updateDoNotContactBodySchema,
  updateProspectBodySchema,
  linkSchema,
  listReachable,
  updateProspectStatus,
  updateProspect,
  listProjectProspects,
  listTenantProspects,
  linkProspects,
  updateDoNotContact,
} from '../../services/prospects'
import {
  batchSchema,
  importSchema,
  checkDedupSchema,
  batchRegister,
  importCsv,
  checkProspectDedup,
} from '../../services/prospect-import'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const prospectsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

prospectsRouter.post('/prospects/batch', zValidator('json', batchSchema), async (c) => {
  const result = await batchRegister(
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

prospectsRouter.post('/prospects/import', zValidator('json', importSchema), async (c) => {
  const result = await importCsv(
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

prospectsRouter.post('/prospects/check-dedup', zValidator('json', checkDedupSchema), async (c) => {
  const result = await checkProspectDedup(
    c.get('db'),
    c.get('tenantId'),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

prospectsRouter.get(
  '/projects/:id/prospects/reachable',
  zValidator('param', projectRefParamSchema),
  zValidator('query', reachableQuerySchema),
  async (c) => {
    const result = await listReachable(
      c.get('db'),
      c.get('tenantId'),
      c.get('edition'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.patch(
  '/prospects/:id/status',
  zValidator('param', prospectIdParamSchema),
  zValidator('json', updateProspectStatusBodySchema),
  async (c) => {
    const result = await updateProspectStatus(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.get(
  '/projects/:id/prospects',
  zValidator('param', projectRefParamSchema),
  zValidator('query', listProjectProspectsQuerySchema),
  async (c) => {
    const result = await listProjectProspects(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('query'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.get(
  '/tenant/prospects',
  zValidator('query', listTenantProspectsQuerySchema),
  async (c) => {
    const result = await listTenantProspects(c.get('db'), c.get('tenantId'), c.req.valid('query'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.post(
  '/projects/:id/prospects/link',
  zValidator('param', projectRefParamSchema),
  zValidator('json', linkSchema),
  async (c) => {
    const result = await linkProspects(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.patch(
  '/prospects/:id',
  zValidator('param', prospectIdParamSchema),
  zValidator('json', updateProspectBodySchema),
  async (c) => {
    const result = await updateProspect(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

prospectsRouter.patch(
  '/prospects/:id/do-not-contact',
  zValidator('param', prospectIdParamSchema),
  zValidator('json', updateDoNotContactBodySchema),
  async (c) => {
    const result = await updateDoNotContact(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
