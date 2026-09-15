import { __cloudEditionWitness, type CloudEdition, type Edition } from '../domain/edition'
import { ok, err, type ServiceResult } from './result'

// NOT_FOUND (not FORBIDDEN) is deliberate: from a self-hosted client's
// perspective the endpoint genuinely does not exist on this install.
// Stripe-bound service functions accept CloudEdition as the leading argument
// so passing the guard through `if (!guard.ok) return guard` is the only way
// the call typechecks.
export function requireCloudEdition(edition: Edition): ServiceResult<CloudEdition> {
  if (edition === 'cloud') return ok(__cloudEditionWitness)
  return err(
    'NOT_FOUND',
    'Endpoint not available on this LeadAce install',
    'Billing is only available on the LeadAce Cloud edition. ' +
      'Self-hosted installs run on the unlimited tier without Stripe.',
  )
}

// Cloud-only routes call this AFTER requireCloudEdition: missing values are
// then a deployment misconfig (INTERNAL_ERROR), not a 404.
export function requireStripeEnv(env: {
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}): ServiceResult<{ secretKey: string; webhookSecret: string }> {
  const secretKey = env.STRIPE_SECRET_KEY
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET
  if (!secretKey || !webhookSecret) {
    return err(
      'INTERNAL_ERROR',
      'Stripe is not configured on this Worker',
      'STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET must be set on cloud deploys.',
    )
  }
  return ok({ secretKey, webhookSecret })
}
