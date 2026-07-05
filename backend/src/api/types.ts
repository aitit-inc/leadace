import type { Db } from '../db/connection'
import type { Edition } from '../domain/edition'
import type { TenantId } from '../domain/ids'

export type Env = {
  DATABASE_URL: string
  SUPABASE_JWT_SECRET: string
  SUPABASE_URL: string
  ENVIRONMENT: string
  // Stripe is cloud-only; self-hosted installs leave these unset. The billing /
  // stripe-webhook routes are gated behind requireCloudEdition, which guarantees
  // presence (see services/runtime-guards.ts:requireStripeEnv for the narrowing).
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // Cloud-only, for DELETE /me/account (removes the auth.users row after the
  // tenant cascade). Self-host leaves it unset — the admin call is gated behind
  // requireCloudEdition.
  SUPABASE_SERVICE_ROLE_KEY?: string
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  UNSUBSCRIBE_TOKEN_SECRET: string
  APP_URL: string
  OPENAI_API_KEY: string
  // Google AI Studio key for the daily org-signal refresh cron.
  GEMINI_API_KEY: string
  // 'cloud' on the hosted SurpassOne deploy, 'self-hosted' (default) for
  // local dev and public-repo self-hosters. See domain/edition.ts.
  LEADACE_EDITION: string
  // E2E test harness only. When set (in local .dev.vars or a staging worker
  // secret), every outbound Gmail call collapses To: / Cc: / Bcc: to this single
  // mailbox and preserves the originals in an X-E2E-Original-To header.
  E2E_RECIPIENT_OVERRIDE?: string
  // Cloud-only error tracking. Set as a Worker secret on the hosted deploy;
  // unset everywhere else (local dev, self-host), where Sentry stays a no-op.
  SENTRY_DSN?: string
  // Cloud-only daily KPI digest → Google Chat incoming webhook. Unset everywhere
  // else, where the beta-stats cron no-ops.
  BETA_STATS_WEBHOOK_URL?: string
}

export type Variables = {
  userId: string
  tenantId: TenantId
  db: Db
  // Set by editionMiddleware on every request (incl. unauthenticated public
  // routes); the single source of truth for the install kind in plan / billing.
  edition: Edition
}
