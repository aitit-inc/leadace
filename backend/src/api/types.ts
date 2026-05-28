import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { TenantId } from '../domain/ids'

export type Env = {
  DATABASE_URL: string
  SUPABASE_JWT_SECRET: string
  SUPABASE_URL: string
  ENVIRONMENT: string
  // Stripe is cloud-only. Self-hosted installs leave these unset; the
  // billing / stripe-webhook routes are gated behind requireCloudEdition,
  // which itself guarantees the env vars are present (see
  // services/runtime-guards.ts:requireStripeEnv for the narrowing pattern).
  // Optional here keeps the type honest about that invariant — typing
  // them as required would force self-hosters to set bogus values.
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // Required on cloud for DELETE /me/account (removes the auth.users row after
  // the tenant cascade). Self-host installs can leave this unset — the account
  // route gates the admin call behind requireCloudEdition, so missing key never
  // reaches the guard there. Optional in the type to keep the invariant honest.
  SUPABASE_SERVICE_ROLE_KEY?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  UNSUBSCRIBE_TOKEN_SECRET: string
  APP_URL: string
  OPENAI_API_KEY: string
  // 'cloud' on the hosted SurpassOne deploy, 'self-hosted' (default) for
  // local dev and public-repo self-hosters. See domain/edition.ts.
  LEADACE_EDITION: string
  // E2E test harness only. When set (in local .dev.vars or a staging
  // worker secret), every outbound Gmail call collapses To: / Cc: / Bcc:
  // to this single mailbox and preserves the originals in an
  // X-E2E-Original-To header. Unset (the production default) is a no-op.
  E2E_RECIPIENT_OVERRIDE?: string
}

export type Variables = {
  userId: string
  tenantId: TenantId
  db: Db
  // Set by editionMiddleware on every request (incl. unauthenticated public
  // routes). Routes pass this to plan / billing services so the Stripe and
  // quota code paths share a single source of truth for the install kind.
  edition: Edition
}
