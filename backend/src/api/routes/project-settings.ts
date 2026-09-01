import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  updateSettingsSchema,
  getProjectSettings,
  updateProjectSettings,
} from '../../services/project-settings'
import { projectRefParamSchema } from '../../services/projects'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const projectSettingsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

projectSettingsRouter.get(
  '/projects/:id/settings',
  zValidator('param', projectRefParamSchema),
  async (c) => {
    const result = await getProjectSettings(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.env.SHOWCASE_PROJECT_ID ?? null,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

projectSettingsRouter.put(
  '/projects/:id/settings',
  zValidator('param', projectRefParamSchema),
  zValidator('json', updateSettingsSchema),
  async (c) => {
    const result = await updateProjectSettings(
      c.get('db'),
      c.get('tenantId'),
      c.get('caller'),
      c.req.valid('param').id,
      c.req.valid('json'),
      c.env.SHOWCASE_PROJECT_ID ?? null,
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)
