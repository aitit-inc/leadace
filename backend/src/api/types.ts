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
  // tenant cascade) and for the auth middleware's deleted-user guard before
  // provisioning a tenant. Self-host leaves it unset — the admin delete is
  // gated behind requireCloudEdition and the guard is skipped.
  SUPABASE_SERVICE_ROLE_KEY?: string
  // Same KV namespace as the MCP Worker; DELETE /me/account revokes the
  // user's MCP token families through it.
  MCP_OAUTH_STORE: KVNamespace
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  GMAIL_TOKEN_ENCRYPTION_KEY: string
  UNSUBSCRIBE_TOKEN_SECRET: string
  APP_URL: string
  OPENAI_API_KEY: string
  // Google AI Studio key: daily org-signal refresh cron + onboarding web preview.
  GEMINI_API_KEY: string
  // Absent leaves only the free DNS half of the send-time address check.
  EMAILABLE_API_KEY?: string
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
  // Project whose numbers the public GET /api/live scoreboard shows (the
  // operator's own dogfooding project). Unset → /api/live is 404.
  SHOWCASE_PROJECT_ID?: string
}

export type Variables = {
  userId: string
  // Which credential authenticated the request: a browser session or an MCP
  // token (JWT audience). Lets a service keep a field UI-only.
  caller: 'browser' | 'mcp'
  tenantId: TenantId
  db: Db
  // Set by editionMiddleware on every request (incl. unauthenticated public
  // routes); the single source of truth for the install kind in plan / billing.
  edition: Edition
}
