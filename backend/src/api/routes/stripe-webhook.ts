import { Hono } from 'hono'
import { createDb } from '../../db/connection'
import {
  handleStripeEvent,
  verifyStripeSignature,
  type StripeEvent,
} from '../../services/stripe-webhook'
import { requireCloudEdition, requireStripeEnv } from '../../services/runtime-guards'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

// Public, unauthenticated webhook (auth is the Stripe signature). Bypasses
// the RLS middleware: the dispatcher writes to tenant_plans for arbitrary
// tenants on Stripe's behalf, so it must run as the unscoped postgres role.
export const stripeWebhookRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

stripeWebhookRouter.post('/stripe/webhook', async (c) => {
  // Self-hosted installs do not run Stripe. We 404 before any DB or HMAC work
  // so a stale Stripe webhook URL pointing at a self-hosted Worker is
  // unambiguously rejected; Stripe will surface the 404 in its dashboard.
  const cloud = requireCloudEdition(c.get('edition'))
  if (!cloud.ok) return respondWithError(c, cloud)
  const stripe = requireStripeEnv(c.env)
  if (!stripe.ok) return respondWithError(c, stripe)

  const signature = c.req.header('stripe-signature')
  if (!signature) {
    return c.json({ error: 'Missing stripe-signature header' }, 400)
  }

  // HMAC is computed over the exact raw bytes — JSON-parsing first would lose
  // whitespace canonicalization and break verification. Signature verification
  // is the input validation here; no zValidator.
  const rawBody = await c.req.text()
  const valid = await verifyStripeSignature(rawBody, signature, stripe.value.webhookSecret)
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401)
  }

  const event = JSON.parse(rawBody) as StripeEvent
  const db = createDb(c.env.DATABASE_URL)

  await handleStripeEvent(db, stripe.value.secretKey, event)

  // Always 200: Stripe retries non-2xx for up to 3 days, and any failure to
  // process is already logged inside the handler.
  return c.json({ received: true })
})
