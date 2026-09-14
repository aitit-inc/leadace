import { Hono } from 'hono'
import { zValidator } from '../zvalidator'
import {
  checkoutBodySchema,
  portalBodySchema,
  getPlanInfo,
  createCheckoutSession,
  createPortalSession,
} from '../../services/billing'
import {
  creditCheckoutBodySchema,
  createCreditCheckoutSession,
  updateAutoTopUp,
} from '../../services/credits'
import { autoTopUpSchema } from '../../domain/credits'
import {
  planChangeBodySchema,
  getSubscriptionInfo,
  changePlan,
  cancelPlanChange,
} from '../../services/plan-change'
import { requireCloudEdition, requireStripeEnv } from '../../services/runtime-guards'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const billingRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

// Available on every edition; self-hosted installs see plan='unlimited'
// with empty quota windows.
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

billingRouter.get('/me/subscription', async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await getSubscriptionInfo(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    { secretKey: stripe.value.secretKey },
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.post('/me/plan-change', zValidator('json', planChangeBodySchema), async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await changePlan(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    { secretKey: stripe.value.secretKey },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.delete('/me/plan-change', async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await cancelPlanChange(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    { secretKey: stripe.value.secretKey },
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.post('/me/credits/checkout', zValidator('json', creditCheckoutBodySchema), async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await createCreditCheckoutSession(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    { secretKey: stripe.value.secretKey, origin: c.req.header('origin') ?? '' },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})

billingRouter.put('/me/credits/auto-top-up', zValidator('json', autoTopUpSchema), async (c) => {
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)
  const result = await updateAutoTopUp(
    cloud.value,
    c.get('db'),
    c.get('tenantId'),
    c.get('edition'),
    { secretKey: stripe.value.secretKey },
    c.req.valid('json'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json(result.value)
})
