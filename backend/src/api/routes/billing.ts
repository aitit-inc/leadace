import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  checkoutBodySchema,
  portalBodySchema,
  getPlanInfo,
  createCheckoutSession,
  createPortalSession,
} from '../../services/billing'
import { requireCloudEdition, requireStripeEnv } from '../../services/runtime-guards'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const billingRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// GET /me/plan — current plan + quota info. Available on every edition;
// self-hosted installs see plan='unlimited' with empty quota windows.
billingRouter.get('/me/plan', async (c) => {
  const result = await getPlanInfo(c.get('db'), c.get('tenantId'), c.get('edition'))
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.post('/me/checkout', zValidator('json', checkoutBodySchema), async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await createCheckoutSession(
    cloud.value,
    {
      secretKey: stripe.value.secretKey,
      userId: c.get('userId'),
      origin: c.req.header('origin') ?? '',
    },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.post('/me/portal', zValidator('json', portalBodySchema), async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await createPortalSession(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    {
      secretKey: stripe.value.secretKey,
      origin: c.req.header('origin') ?? '',
    },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
