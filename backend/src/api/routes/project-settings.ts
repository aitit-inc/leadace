import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  updateSettingsSchema,
  getProjectSettings,
  updateProjectSettings,
} from '../../services/project-settings'
import { projectIdParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const projectSettingsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

projectSettingsRouter.get(
  '/projects/:id/settings',
  zValidator('param', projectIdParamSchema),
  async (c) => {
    const result = await getProjectSettings(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

projectSettingsRouter.put(
  '/projects/:id/settings',
  zValidator('param', projectIdParamSchema),
  zValidator('json', updateSettingsSchema),
  async (c) => {
    const result = await updateProjectSettings(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
