import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  saveCredentialsSchema,
  saveCredentials,
  getCredentialsStatus,
} from '../../services/google-auth'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const authRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

authRouter.post(
  '/auth/google-credentials',
  zValidator('json', saveCredentialsSchema),
  async (c) => {
    const result = await saveCredentials(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      { encryptionKey: c.env.GMAIL_TOKEN_ENCRYPTION_KEY },
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json(result.value)
  },
)

authRouter.get('/auth/google-credentials/status', async (c) => {
  const result = await getCredentialsStatus(c.get('db'), c.get('tenantId'), c.get('userId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
