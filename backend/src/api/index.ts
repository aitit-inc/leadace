import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { authMiddleware } from './middleware/auth'
import { rlsMiddleware } from './middleware/rls'
import { editionMiddleware } from './middleware/edition'
import { projectsRouter } from './routes/projects'
import { projectSettingsRouter } from './routes/project-settings'
import { tenantSettingsRouter } from './routes/tenant-settings'
import { subjectVariantsRouter } from './routes/subject-variants'
import { prospectsRouter } from './routes/prospects'
import { organizationsRouter } from './routes/organizations'
import { outreachRouter } from './routes/outreach'
import { responsesRouter } from './routes/responses'
import { evaluationsRouter } from './routes/evaluations'
import { documentsRouter } from './routes/documents'
import { masterDocumentsRouter } from './routes/master-documents'
import { billingRouter } from './routes/billing'
import { authRouter } from './routes/auth'
import { accountRouter } from './routes/account'
import { bugReportsRouter } from './routes/bug-reports'
import { stripeWebhookRouter } from './routes/stripe-webhook'
import { unsubscribeRouter } from './routes/unsubscribe'
import { inquiryRouter } from './routes/inquiry'
import { createDb } from '../db/connection'
import { runDailySignalRefresh } from '../services/org-signals'
import type { Env, Variables } from './types'

const app = new Hono<{ Bindings: Env; Variables: Variables }>()

// Wide-open CORS is intentional: every endpoint authenticates per-request
// (Supabase JWT for /api/*, HMAC token for /unsubscribe/*, short_id for
// /inquiry/*, Stripe signature for /webhook). The browser origin is not
// part of any auth decision — gating it would just block legitimate
// CLI/local-dev/self-host traffic without raising the security bar.
app.use('*', cors())
// Resolves LEADACE_EDITION into Variables for every request. Must run before
// any route that gates on edition (Stripe webhook, billing, /me/plan, …).
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
app.route('/api', prospectsRouter)
app.route('/api', organizationsRouter)
app.route('/api', outreachRouter)
app.route('/api', responsesRouter)
app.route('/api', evaluationsRouter)
app.route('/api', documentsRouter)
app.route('/api', masterDocumentsRouter)
app.route('/api', billingRouter)
app.route('/api', authRouter)
app.route('/api', accountRouter)
app.route('/api', bugReportsRouter)

app.onError((err, c) => {
  console.error(err)
  return c.json({ error: 'Internal server error' }, 500)
})

export default {
  fetch: app.fetch,

  // Cloudflare cron handler. Runs as the system (no auth, no RLS) and only
  // touches the global org_signals_global table — keeping the surface
  // narrow so we don't accidentally bypass tenant isolation here.
  // ctx.waitUntil keeps the worker alive past the cron tick's quick return
  // until the refresh batch settles.
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const db = createDb(env.DATABASE_URL)
    ctx.waitUntil(
      runDailySignalRefresh(db, env)
        .then((summary) => {
          console.log('[scheduled] org-signals refresh', summary)
        })
        .catch((e: unknown) => {
          console.error('[scheduled] org-signals refresh failed', e)
        }),
    )
  },
}
