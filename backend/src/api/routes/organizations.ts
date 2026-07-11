import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  organizationIdParamSchema,
  listOrganizationsQuerySchema,
  updateOrganizationBodySchema,
  deleteOrganizationsBodySchema,
  listOrganizations,
  getOrganization,
  updateOrganization,
  deleteOrganizations,
} from '../../services/organizations'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const organizationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

organizationsRouter.get(
  '/organizations',
  zValidator('query', listOrganizationsQuerySchema),
  async (c) => {
    const result = await listOrganizations(c.get('db'), c.get('tenantId'), c.req.valid('query'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

organizationsRouter.post(
  '/organizations/delete-batch',
  zValidator('json', deleteOrganizationsBodySchema),
  async (c) => {
    const result = await deleteOrganizations(c.get('db'), c.get('tenantId'), c.req.valid('json'))
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

organizationsRouter.get(
  '/organizations/:id',
  zValidator('param', organizationIdParamSchema),
  async (c) => {
    const result = await getOrganization(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

organizationsRouter.patch(
  '/organizations/:id',
  zValidator('param', organizationIdParamSchema),
  zValidator('json', updateOrganizationBodySchema),
  async (c) => {
    const result = await updateOrganization(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
