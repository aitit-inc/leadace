import { Hono } from 'hono'
import {
  registerSmtpIdentitySchema,
  registerSmtpIdentity,
  registerGmailAliasSchema,
  registerGmailAlias,
  googleMailboxAuthorizationSchema,
  googleMailboxAuthorizationUrl,
  registerGoogleMailboxSchema,
  registerGoogleMailbox,
  listSendingIdentities,
  deleteSendingIdentity,
  type GoogleMailboxCtx,
} from '../../services/sending-identity'
import { updateMailboxWarmup, updateMailboxWarmupSchema } from '../../services/plan-limits'
import { sendingIdentityIdParamSchema } from '../../domain/ids'
import { zValidator } from '../zvalidator'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const sendingIdentitiesRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

const googleMailboxCtx = (env: Env): GoogleMailboxCtx => ({
  encryptionKey: env.GMAIL_TOKEN_ENCRYPTION_KEY,
  clientId: env.GOOGLE_CLIENT_ID,
  clientSecret: env.GOOGLE_CLIENT_SECRET,
  appUrl: env.APP_URL,
})

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

sendingIdentitiesRouter.post(
  '/me/sending-identities/gmail-aliases',
  zValidator('json', registerGmailAliasSchema),
  async (c) => {
    const result = await registerGmailAlias(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.get('edition'),
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value, 201) : respondWithError(c, result)
  },
)

sendingIdentitiesRouter.post(
  '/me/sending-identities/google-mailboxes/authorization-url',
  zValidator('json', googleMailboxAuthorizationSchema),
  (c) => c.json(googleMailboxAuthorizationUrl(googleMailboxCtx(c.env), c.req.valid('json'))),
)

sendingIdentitiesRouter.post(
  '/me/sending-identities/google-mailboxes',
  zValidator('json', registerGoogleMailboxSchema),
  async (c) => {
    const result = await registerGoogleMailbox(
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.get('edition'),
      googleMailboxCtx(c.env),
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value, 201) : respondWithError(c, result)
  },
)

sendingIdentitiesRouter.put(
  '/me/sending-identities/:id/warmup',
  zValidator('param', sendingIdentityIdParamSchema),
  zValidator('json', updateMailboxWarmupSchema),
  async (c) => {
    const result = await updateMailboxWarmup(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value) : respondWithError(c, result)
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
