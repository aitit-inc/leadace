import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  updateTenantSettingsSchema,
  loadTenantSettings,
  updateTenantSettings,
  getTenantComplianceStatus,
} from '../../services/tenants'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const tenantSettingsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

tenantSettingsRouter.get('/tenant-settings', async (c) => {
  const result = await loadTenantSettings(c.get('db'), c.get('tenantId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

tenantSettingsRouter.put(
  '/tenant-settings',
  zValidator('json', updateTenantSettingsSchema),
  async (c) => {
    const result = await updateTenantSettings(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

tenantSettingsRouter.get('/tenant/compliance-status', async (c) => {
  const result = await getTenantComplianceStatus(c.get('db'), c.get('tenantId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
