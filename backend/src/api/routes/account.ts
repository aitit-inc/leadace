import { Hono } from 'hono'
import { deleteOwnAccount } from '../../services/account-deletion'
import {
  requireStripeEnv,
  requireSupabaseAdminEnv,
} from '../../services/runtime-guards'
import { getOnboardingStatus } from '../../services/tenants'
import { respondWithError } from '../respond'
import type { Env, Variables } from '../types'

export const accountRouter = new Hono<{ Bindings: Env; Variables: Variables }>()

accountRouter.get('/me/onboarding-status', async (c) => {
  const result = await getOnboardingStatus(c.get('db'), c.get('tenantId'))
  return result.ok ? c.json(result.value) : respondWithError(c, result)
})

accountRouter.delete('/me/account', async (c) => {
  let stripeKey: string | null = null
  let adminKey: string | null = null
  if (c.get('edition') === 'cloud') {
    const stripe = requireStripeEnv(c.env)
    if (!stripe.ok) return respondWithError(c, stripe)
    stripeKey = stripe.value.secretKey
    const admin = requireSupabaseAdminEnv(c.env)
    if (!admin.ok) return respondWithError(c, admin)
    adminKey = admin.value.serviceRoleKey
  }

  const result = await deleteOwnAccount(
    {
      databaseUrl: c.env.DATABASE_URL,
      supabaseUrl: c.env.SUPABASE_URL,
      stripeKey,
      adminKey,
    },
    c.get('db'),
    c.get('tenantId'),
    c.get('userId'),
  )
  if (!result.ok) return respondWithError(c, result)
  return c.json({}, 200)
})
