import { Hono } from 'hono'
import {
  accountDeletionSurveySchema,
  deleteOwnAccount,
} from '../../services/account-deletion'
import { requireStripeEnv } from '../../services/runtime-guards'
import { getOnboardingStatus } from '../../services/tenants'
import { respondWithError } from '../respond'
import { zValidator } from '../zvalidator'
import type { Env, Variables } from '../types'

export const accountRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

accountRouter.get('/me/onboarding-status', async (c) => {
  const result = await getOnboardingStatus(c.get('db'), c.get('tenantId'))
  return result.ok ? c.json(result.value) : respondWithError(c, result)
})

accountRouter.delete(
  '/me/account',
  zValidator('json', accountDeletionSurveySchema),
  async (c) => {
    let stripeKey: string | null = null
    if (c.get('edition') === 'cloud') {
      const stripe = requireStripeEnv(c.env)
      if (!stripe.ok) return respondWithError(c, stripe)
      stripeKey = stripe.value.secretKey
    }

    const result = await deleteOwnAccount(
      {
        databaseUrl: c.env.DATABASE_URL,
        stripeKey,
        mcpOauthStore: c.env.MCP_OAUTH_STORE,
        attachments: c.env.ATTACHMENTS,
      },
      c.get('db'),
      c.get('tenantId'),
      c.get('userId'),
      c.req.valid('json'),
    )
    if (!result.ok) return respondWithError(c, result)
    return c.json({}, 200)
  },
)
