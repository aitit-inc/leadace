import { Hono } from 'hono'
import {
  registerSmtpIdentitySchema,
  registerSmtpIdentity,
  listSendingIdentities,
  deleteSendingIdentity,
} from '../../services/sending-identity'
import { sendingIdentityIdParamSchema } from '../../domain/ids'
import { zValidator } from '../zvalidator'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const sendingIdentitiesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

sendingIdentitiesRouter.get('/me/sending-identities', async (c) => {
  const identities = await listSendingIdentities(
    c.get('db'),
    c.get('tenantId'),
    c.env.GMAIL_TOKEN_ENCRYPTION_KEY,
  )
  return c.json({ identities })
})

sendingIdentitiesRouter.post(
  '/me/sending-identities',
  zValidator('json', registerSmtpIdentitySchema),
  async (c) => {
    const result = await registerSmtpIdentity(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.get('edition'),
      { encryptionKey: c.env.GMAIL_TOKEN_ENCRYPTION_KEY },
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value, 201) : respondWithError(c, result)
  },
)

sendingIdentitiesRouter.delete(
  '/me/sending-identities/:id',
  zValidator('param', sendingIdentityIdParamSchema),
  async (c) => {
    const result = await deleteSendingIdentity(c.get('db'), c.get('tenantId'), c.req.valid('param').id)
    return result.ok ? c.json(result.value) : respondWithError(c, result)
  },
)
