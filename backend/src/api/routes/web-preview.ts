import { Hono } from 'hono'
import {
  generateWebPreview,
  generateWebPreviewSchema,
  getLatestWebPreview,
} from '../../services/web-preview'
import { respondWithError } from '../respond'
import { zValidator } from '../zvalidator'
import type { Env, Variables } from '../types'

export const webPreviewRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

webPreviewRouter.get('/me/web-preview', async (c) => {
  const result = await getLatestWebPreview(c.get('db'), c.get('tenantId'))
  return result.ok ? c.json(result.value) : respondWithError(c, result)
})

webPreviewRouter.post(
  '/me/web-preview',
  zValidator('json', generateWebPreviewSchema),
  async (c) => {
    const result = await generateWebPreview(
      c.get('db'),
      c.get('tenantId'),
      { GEMINI_API_KEY: c.env.GEMINI_API_KEY },
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value, 201) : respondWithError(c, result)
  },
)
