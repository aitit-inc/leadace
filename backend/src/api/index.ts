import { Hono } from 'hono'
import { cors } from 'hono/cors'
import * as Sentry from '@sentry/cloudflare'
import { sentryOptions } from '../sentry'
import { authMiddleware } from './middleware/auth'
import { rlsMiddleware } from './middleware/rls'
import { editionMiddleware } from './middleware/edition'
import { projectsRouter } from './routes/projects'
import { projectSettingsRouter } from './routes/project-settings'
import { tenantSettingsRouter } from './routes/tenant-settings'
import { subjectVariantsRouter } from './routes/subject-variants'
import { leversRouter } from './routes/levers'
import { dashboardRouter } from './routes/dashboard'
import { prospectsRouter } from './routes/prospects'
import { organizationsRouter } from './routes/organizations'
import { outreachRouter } from './routes/outreach'
import { responsesRouter } from './routes/responses'
import { evaluationsRouter } from './routes/evaluations'
import { documentsRouter } from './routes/documents'
import { masterDocumentsRouter } from './routes/master-documents'
import { countryCodesRouter } from './routes/country-codes'
import { billingRouter } from './routes/billing'
import { mailboxRouter } from './routes/mailbox'
import { sendingIdentitiesRouter } from './routes/sending-identities'
import { authRouter } from './routes/auth'
import { accountRouter } from './routes/account'
import { bugReportsRouter } from './routes/bug-reports'
import { stripeWebhookRouter } from './routes/stripe-webhook'
import { unsubscribeRouter } from './routes/unsubscribe'
import { inquiryRouter } from './routes/inquiry'
import { createDb } from '../db/connection'
import { runDailySignalRefresh } from '../services/org-signals'
import { runDailyBetaStats } from '../services/beta-stats'
import { runReplyIngest } from '../services/reply-ingest'
import type { Env, Variables } from './types'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Wide-open CORS is intentional: every endpoint authenticates per-request
// (Supabase JWT for /api/*, HMAC token for /unsubscribe/*, short_id for
// /inquiry/*, Stripe signature for /webhook). The browser origin is not
// part of any auth decision — gating it would just block legitimate
// CLI/local-dev/self-host traffic without raising the security bar.
app.use('*', cors())
// Must run before any route that gates on edition (Stripe webhook, billing, /me/plan, …).
app.use('*', editionMiddleware)

app.get('/health', (c) => c.json({ ok: true }))

// Stripe webhook — no auth middleware (uses Stripe signature verification)
app.route('/api', stripeWebhookRouter)

// Unsubscribe endpoints — no auth middleware. The HMAC token in the URL is
// the auth and authorizes flipping prospects.do_not_contact for one prospect.
app.route('/api', unsubscribeRouter)

// Mounted before the global auth block — public sub-routes use the
// short_id as auth; `/inquiry/preview` re-attaches auth+rls inline.
app.route('/api', inquiryRouter)

// All routes below require authentication + tenant-scoped RLS
app.use('/api/*', authMiddleware)
app.use('/api/*', rlsMiddleware)

app.route('/api/projects', projectsRouter)
app.route('/api', projectSettingsRouter)
app.route('/api', tenantSettingsRouter)
app.route('/api', subjectVariantsRouter)
app.route('/api', leversRouter)
app.route('/api', dashboardRouter)
app.route('/api', prospectsRouter)
app.route('/api', organizationsRouter)
app.route('/api', outreachRouter)
app.route('/api', responsesRouter)
app.route('/api', evaluationsRouter)
app.route('/api', documentsRouter)
app.route('/api', masterDocumentsRouter)
app.route('/api', countryCodesRouter)
app.route('/api', billingRouter)
app.route('/api', mailboxRouter)
app.route('/api', sendingIdentitiesRouter)
app.route('/api', authRouter)
app.route('/api', accountRouter)
app.route('/api', bugReportsRouter)

app.onError((err, c) => {
  console.error(err)
  // onError returns a clean 500 without rethrowing, so withSentry alone would
  // never see these — capture here. No-op when SENTRY_DSN is unset.
  Sentry.captureException(err)
  return c.json({ error: 'Internal server error' }, 500)
})

// org-signals refresh is pinned to this schedule; keep in sync with the
// `crons` arrays in wrangler.api.jsonc. Every other scheduled trigger (the
// 0 4 beta digest, or a temporary test cron) falls through to the digest, so
// its schedule can change in wrangler without touching this dispatch.
const ORG_SIGNALS_CRON = '0 3 * * *'
// Hourly server-side reply poll; keep in sync with the wrangler.api.jsonc crons.
const REPLY_INGEST_CRON = '0 * * * *'

const handler = {
  fetch: app.fetch,

  // Cron runs on a raw createDb connection that BYPASSES RLS, and reply-ingest
  // performs tenant-scoped writes here — so every query on this path MUST filter
  // by tenant_id explicitly; there is no RLS backstop.
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.DATABASE_URL)

    if (controller.cron === ORG_SIGNALS_CRON) {
      ctx.waitUntil(
        runDailySignalRefresh(db, env)
          .then((summary) => {
            // Workers Logs only indexes the message string for search.
            console.log(
              `[scheduled] org-signals refresh picked=${summary.picked} updated=${summary.updated} empty=${summary.empty} failed=${summary.failed} staleRemaining=${summary.staleRemaining}`,
            )
          })
          .catch((e: unknown) => {
            console.error('[scheduled] org-signals refresh failed', e)
            // Scheduled failures never hit Hono onError — report them directly.
            Sentry.captureException(e)
          }),
      )
      return
    }

    if (controller.cron === REPLY_INGEST_CRON) {
      ctx.waitUntil(
        runReplyIngest(db, env)
          .then((s) => {
            console.log(
              `[scheduled] reply-ingest polled=${s.identitiesPolled} skipped=${s.identitiesSkipped} errors=${s.pollErrors} recorded=${s.recorded} deduped=${s.deduped} unattributed=${s.unattributed} recordErrors=${s.recordErrors} bouncesThreaded=${s.bouncesThreaded} bouncesUnthreaded=${s.bouncesUnthreaded}`,
            )
          })
          .catch((e: unknown) => {
            console.error('[scheduled] reply-ingest failed', e)
            Sentry.captureException(e)
          }),
      )
      return
    }

    // Log the dispatch so a test/temporary cron is visible in Workers Logs
    // even on a successful or no-op run.
    console.log(`[scheduled] beta-stats digest cron=${controller.cron}`)
    ctx.waitUntil(
      runDailyBetaStats(db, env).catch((e: unknown) => {
        console.error(`[scheduled] beta-stats failed cron=${controller.cron}`, e)
        Sentry.captureException(e)
      }),
    )
  },
}

export default Sentry.withSentry(
  (env: Env) => sentryOptions(env.SENTRY_DSN, env.ENVIRONMENT),
  handler,
)
