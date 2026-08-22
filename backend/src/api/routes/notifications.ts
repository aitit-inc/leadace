import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import { notifyUserSchema, notifyUser } from '../../services/notifications'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const notificationsRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

notificationsRouter.post('/notifications', zValidator('json', notifyUserSchema), async (c) => {
  const result = await notifyUser(
    c.get('db'),
    c.get('tenantId'),
    c.get('userId'),
    {
      encryptionKey: c.env.GMAIL_TOKEN_ENCRYPTION_KEY,
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      e2eRecipientOverride: c.env.E2E_RECIPIENT_OVERRIDE ?? null,
    },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value, 200)
})
