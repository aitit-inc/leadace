import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  saveCredentialsSchema,
  sendEmailSchema,
  saveCredentials,
  getCredentialsStatus,
  sendInternalEmail,
  type GoogleCtx,
} from '../../services/google-auth'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'
import type { Context } from 'hono'

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

authRouter.post('/auth/send-email', zValidator('json', sendEmailSchema), async (c) => {
  const result = await sendInternalEmail(
    c.get('db'),
    c.get('tenantId'),
    c.get('userId'),
    googleCtx(c),
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 200)
})

function googleCtx(c: Context<{ Bindings: Env; Variables: Variables }>): GoogleCtx {
  return {
    encryptionKey: c.env.GMAIL_TOKEN_ENCRYPTION_KEY,
    clientId: c.env.GOOGLE_CLIENT_ID,
    clientSecret: c.env.GOOGLE_CLIENT_SECRET,
    e2eRecipientOverride: c.env.E2E_RECIPIENT_OVERRIDE ?? null,
  }
}
