import { Hono } from 'hono'
import { getCredentialsStatus } from '../../services/google-auth'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const authRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

authRouter.get('/auth/google-credentials/status', async (c) => {
  const result = await getCredentialsStatus(c.get('db'), c.get('tenantId'), c.get('userId'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
