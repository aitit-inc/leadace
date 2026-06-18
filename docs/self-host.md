# Self-Host LeadAce

LeadAce's backend is open source under a [modified Apache 2.0
license](../LICENSE) and runs on free tiers of Cloudflare and Supabase.
Self-hosted installs run on the **unlimited** edition by default — no
Stripe, no plan caps. Two paths:

| Goal | Section |
|---|---|
| Hack on the codebase locally | [Local development](#local-development) |
| Run your own production for one team | [Production self-deploy](#production-self-deploy) |

Cloudflare Workers (`workerd`) does not run reliably inside Docker on
macOS, so neither path tries to put the backend in a container. Postgres
+ Supabase Auth run in Docker via the Supabase CLI; the Workers run on
the host.

## Editions

LeadAce ships with a single `LEADACE_EDITION` env var that determines
what billing surfaces are active:

| `LEADACE_EDITION` | Plan resolution | Stripe routes | Frontend billing UI |
|---|---|---|---|
| `self-hosted` (default) | Every tenant resolves to `unlimited` | `/me/checkout`, `/me/portal`, `/stripe/webhook` return 404 | Hidden |
| `cloud` | `tenant_plans` row is read; defaults to `free` if missing | Mounted as normal | Visible |

The default is `self-hosted` — a misconfigured cloud build loses billing
UI (visible, fixable), but the inverse would silently expose Stripe code
paths. Failing closed is the only safe default. Most self-hosters should
leave both `LEADACE_EDITION` (backend) and `PUBLIC_LEADACE_EDITION`
(frontend) at `self-hosted`.

## Local development

Prerequisites: Docker Desktop (or Podman), Node.js 22+, Supabase CLI
(`brew install supabase/tap/supabase` on macOS, see
[Supabase CLI install docs](https://supabase.com/docs/guides/local-development/cli/getting-started)
for other platforms), Claude Code.

The frontend `/login` page is Google-only — there is no
email/password fallback — so signing in to your local stack requires
a Google OAuth client wired into the local Supabase Auth instance.
Set this up once before the first `npx supabase start`:

1. In [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials),
   create an OAuth 2.0 Client ID (Application type: Web application).
   - **Authorised JavaScript origins:** `http://localhost:5173`
   - **Authorised redirect URIs:** `http://localhost:54321/auth/v1/callback`
2. Persist the client id / secret to your shell so the
   `[auth.external.google]` block in `supabase/config.toml` (which uses
   `env(...)` interpolation) can read them. The Supabase CLI does not
   support a `--env-file` flag for `supabase start` and does not load
   any `.env` file automatically; the values must be in the parent
   shell process.

   **Recommended: direnv** (per-project, scoped to this repo). Install
   direnv if you don't have it (`brew install direnv` on macOS), add the
   shell hook (`eval "$(direnv hook zsh)"` in `~/.zshrc`), then:

   ```bash
   cp .envrc.example .envrc        # at the repo root
   # edit .envrc — set the two GOOGLE_CLIENT_ID/SECRET values
   direnv allow
   ```

   `cd` into the repo from a fresh shell now exports the vars
   automatically. `.envrc` is gitignored.

   **Alternative:** add the two `export` lines to `~/.zshrc` directly.
   Simpler, but global to every shell — fine for a single-developer
   workflow.

3. Add `https://www.googleapis.com/auth/gmail.send` to the OAuth consent
   screen's scopes if you want outbound email send to work locally.
   (Optional for the smoke / onboarding flow; required for `/outbound`.)

Then copy the env templates and fill them in:

```bash
cp backend/.dev.vars.example backend/.dev.vars  # values from `supabase status`,
                                                # plus GOOGLE_CLIENT_ID/SECRET from step 1
cp frontend/.env.example frontend/.env          # PUBLIC_SUPABASE_*, PUBLIC_API_URL, PUBLIC_MCP_URL
```

`supabase status` prints the JWT secret, anon key, and DB URL the templates ask
for, but only once the local stack is running — so on a first run, fill them in
after the `make dev` below has started Supabase. That one command brings the
whole stack up — Supabase, migrations, the master seed, the API/MCP Workers, and
the frontend:

```bash
make dev          # or: ./scripts/dev.sh
```

It starts Supabase via the CLI if it isn't already up, runs `db:migrate` +
the master-document seed (both idempotent), then runs all three dev servers
(API :8787, MCP :8788, frontend :5173) with prefixed logs. Ctrl-C stops the
dev servers; Supabase stays up for a fast restart (`make stop` halts it). On
first run it `npm ci`s the backend / frontend deps if `node_modules` is absent.

If you change the Google OAuth env (`.envrc`) after a first run, Supabase
won't pick it up — `supabase start` reuses the existing stopped container and
does not re-read `config.toml`'s `env()` interpolation. Run `make stop` then
`make dev` in the same shell to recreate it.

To run the app servers on non-default ports (e.g. 5173 clashes with another
local stack), copy `dev.ports.env.example` to `dev.ports.env` and set
`LEADACE_FRONTEND_PORT` / `LEADACE_API_PORT` / `LEADACE_MCP_PORT`. `dev.sh`
derives every dependent URL from them, and `supabase/config.toml` already
allow-lists `http://localhost:*/auth/callback`, so Google sign-in works on a
custom frontend port without further setup. (Supabase's own ports are separate
— shift them with `SUPABASE_PORT_OFFSET`, below, which additionally needs the
shifted callback registered in Google Cloud Console for interactive sign-in.)
If you change the MCP port, point the plugin at it:
`export LEADACE_MCP_URL=http://localhost:<port>/mcp`.

To connect the plugin from Claude Code:

```bash
# /plugin marketplace add aitit-inc/leadace
# /plugin install leadace@leadace
export LEADACE_MCP_URL=http://localhost:8788/mcp
claude
```

<details>
<summary>Run the steps manually instead</summary>

```bash
npx supabase start                        # Auth + Postgres
cd backend
npm install
npm run db:migrate                        # apply schema
npx tsx scripts/seed-master-documents.ts  # seed plugin templates
npm run dev:api    # API → http://localhost:8787
npm run dev:mcp    # MCP → http://localhost:8788  (separate terminal)
cd ../frontend
npm install
npm run dev                               # → http://localhost:5173
```
</details>

`docker-compose.yml` at the repo root is a bare Postgres alternative for
users who don't want Supabase Auth. It won't satisfy the backend's auth
middleware out of the box — you'd need to swap the JWT verifier.

### Running an isolated (or parallel) Supabase stack

`supabase/config.toml` pins the project to `lead-ace` on fixed ports, so two
checkouts on one machine share the same Docker containers and DB volume. To
give a checkout its own isolated stack — its own containers and DB, leaving any
other local stack (and its data) untouched — run Supabase through the wrapper
instead of the CLI directly:

```bash
SUPABASE_PROJECT_ID=leadace-oss scripts/supabase-local.sh start
SUPABASE_PROJECT_ID=leadace-oss scripts/supabase-local.sh status   # URLs/keys
SUPABASE_PROJECT_ID=leadace-oss scripts/supabase-local.sh stop
```

The wrapper copies the committed config into a gitignored `.supabase-local/`
workdir, rewrites the project id (and ports, if you set one), and forwards the
command with `--workdir`. The Supabase CLI's `env()` interpolation has no
default-value support, so the config itself can't be made env-overridable
without breaking the no-env path — hence the wrapper rather than env vars in
`config.toml`. With `SUPABASE_PROJECT_ID` unset it is a plain passthrough to
`npx supabase`, so the default workflow above is unchanged.

To run two stacks **at the same time**, also set `SUPABASE_PORT_OFFSET` (added
to each Supabase service's listen port) so they don't collide, then read the
shifted URLs from `... status` into `backend/.dev.vars` and `frontend/.env`:

```bash
SUPABASE_PROJECT_ID=leadace-oss SUPABASE_PORT_OFFSET=100 \
  scripts/supabase-local.sh start    # API on 54421, DB on 54422, …
```

The offset shifts the service ports but not the Google `redirect_uri` baked
into `config.toml` (`…:54321/auth/v1/callback`), so an offset stack is meant
for non-interactive use (the curl regression harness, DB work). Interactive
Google sign-in on an offset stack additionally needs the shifted callback URL
registered on your Google OAuth client — easier to just run the offset stack
without sign-in, or run only one stack at the default ports when you need it.

The API/MCP Workers (8787/8788) and frontend (5173) are not Supabase; to run
those alongside another stack, pass their own `--port` flags.

## Production self-deploy

What you need:

- **Cloudflare account** on the **Workers Paid plan** — the daily
  org-signals cron makes up to 200 Gemini calls in one invocation,
  past the Free plan's 50-subrequest limit.
- **Supabase project** (free tier works for evaluation).
- **Domain** (optional — you can run on `*.workers.dev` /
  `*.pages.dev` URLs without a custom domain).
- **No Stripe account required** — the `self-hosted` edition does not
  invoke Stripe. Leave `LEADACE_EDITION=self-hosted` (the default in
  `.dev.vars.example` and `wrangler.api.jsonc`).

Before you start: the published `backend/wrangler.api.jsonc` /
`backend/wrangler.mcp.jsonc` ship with **local-dev defaults only** — no
Cloudflare `account_id`, no production `env` block, no custom-domain
`routes`. SurpassOne's production deploy config is intentionally not part
of the open-source mirror, so you wire up your own:

- **Account:** set `CLOUDFLARE_ACCOUNT_ID` in your shell before
  `wrangler deploy` (the config has no `account_id` line).
- **Runtime vars:** edit the top-level `vars` for a real deployment —
  `APP_URL` in `wrangler.api.jsonc` and `FRONTEND_URL` in
  `wrangler.mcp.jsonc` default to `http://localhost:5173`; point them at
  your frontend URL. `LEADACE_EDITION` is already `self-hosted`, which is
  what you want.
- **Custom domain (optional):** add a `routes` block to the config or
  attach the domain in the Cloudflare dashboard. Without one, the Workers
  are reachable on `*.workers.dev`.

The deploy commands below target the default environment (no
`--env production`), since the published config has no named production
environment. If you prefer the named-environment workflow, add your own
`env.production` block and re-add `--env production` to the commands.

### 1. Set up Supabase

1. [Supabase Dashboard → New project](https://supabase.com/dashboard).
   Pick a region close to your users; pick a strong DB password and
   keep it.
2. After creation, copy these values from
   **Project Settings → API** and **Project Settings → Database**:
   - **Project URL** (e.g. `https://<ref>.supabase.co`)
   - **anon / publishable key** (`sb_publishable_...` on new
     projects, or the legacy `eyJ...` JWT — both work)
   - **service_role key** (only needed for admin scripts; never
     expose to the frontend)
   - **Session Pooler** connection string (port 5432, used for
     migrations)
   - **Transaction Pooler** connection string (port 6543, used by the
     running app — handles high concurrency)
   - **JWT Secret** (Settings → API → "JWT Settings"). The MCP Worker
     mints HS256 tokens with this; the API Worker verifies them.
3. **Authentication → URL Configuration**:
   - Site URL: `https://app.<your-domain>` (or your Pages preview URL).
   - Redirect URLs: add the same hostname plus `/auth/callback`,
     `/auth/*`, and your local dev URL `http://localhost:5173/*` if
     you're going to keep working from a laptop too.
4. **Authentication → Providers**: enable **Google**. The shipped
   `/login` UI is Google-only — there is no email/password login UI, so
   enabling email/password in Supabase alone gives you no way to sign in
   (you'd have to build your own login form). See
   [§10](#10-google-sign-in) for the Google client setup.

### 2. Apply database migrations

```bash
cd backend
npm install
DATABASE_URL="<Session Pooler URL>" npm run db:migrate
DATABASE_URL="<Session Pooler URL>" npx tsx scripts/seed-master-documents.ts
```

`db:migrate` is idempotent — it tracks applied migrations in
`drizzle.__drizzle_migrations`. Always run it against the **Session
Pooler URL (port 5432)**. The Transaction Pooler (port 6543) breaks
DDL like `CREATE ROLE` and `DO` blocks; this is a Supabase quirk, not
a LeadAce one.

`seed-master-documents.ts` populates the `master_documents` table that
the plugin's skills read at runtime. Re-running it is safe — it
upserts.

### 3. Create the MCP OAuth KV namespace

The MCP Worker uses Cloudflare KV to store short-lived OAuth state.
Create a namespace and replace the placeholder ID in
`wrangler.mcp.jsonc`:

```bash
cd backend
npx wrangler kv namespace create MCP_OAUTH_STORE
# → outputs an `id` value. Paste it into the top-level `kv_namespaces`
# block in wrangler.mcp.jsonc, replacing the placeholder id.
```

### 4. Set wrangler secrets

The Worker config files (`backend/wrangler.api.jsonc`,
`backend/wrangler.mcp.jsonc`) declare non-secret `vars` inline. Real
secrets must be set via `wrangler secret put` so they don't end up in
the repository. Local dev uses `backend/.dev.vars` instead.

```bash
cd backend
export CLOUDFLARE_ACCOUNT_ID="<your account id>"
export CLOUDFLARE_API_TOKEN="<token with Workers + Pages + KV scopes>"

# API Worker — required
npx wrangler secret put DATABASE_URL          --config wrangler.api.jsonc
npx wrangler secret put SUPABASE_URL          --config wrangler.api.jsonc
npx wrangler secret put SUPABASE_JWT_SECRET   --config wrangler.api.jsonc
npx wrangler secret put GMAIL_TOKEN_ENCRYPTION_KEY --config wrangler.api.jsonc
npx wrangler secret put UNSUBSCRIBE_TOKEN_SECRET   --config wrangler.api.jsonc

# API Worker — for outbound Gmail send (optional but expected by /api/outreach/send-and-record)
npx wrangler secret put GOOGLE_CLIENT_ID      --config wrangler.api.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET  --config wrangler.api.jsonc

# API Worker — for inquiry-landing AI chat (optional)
npx wrangler secret put OPENAI_API_KEY        --config wrangler.api.jsonc

# API Worker — for grounded org-signal search (required; the daily cron fails without it)
npx wrangler secret put GEMINI_API_KEY        --config wrangler.api.jsonc

# MCP Worker — required
npx wrangler secret put WEB_API_URL           --config wrangler.mcp.jsonc
npx wrangler secret put SUPABASE_URL          --config wrangler.mcp.jsonc
npx wrangler secret put SUPABASE_ANON_KEY     --config wrangler.mcp.jsonc
npx wrangler secret put SUPABASE_JWT_SECRET   --config wrangler.mcp.jsonc
```

Notes:

- `DATABASE_URL` here is the **Transaction Pooler** URL (port 6543)
  — opposite of the migration step. The app benefits from connection
  multiplexing under load.
- `SUPABASE_JWT_SECRET` must be the same value on both Workers; the
  MCP Worker signs tokens with it and the API Worker verifies them.
- `GMAIL_TOKEN_ENCRYPTION_KEY` and `UNSUBSCRIBE_TOKEN_SECRET` are any
  32+ char passphrases. They protect data at rest and HMAC the
  unsubscribe links — do not change them once data exists. Rotating
  `UNSUBSCRIBE_TOKEN_SECRET` invalidates every previously sent
  unsubscribe link.
- See `wrangler.api.jsonc` for the per-secret comments that explain
  what fails if a value is missing.

### 5. Deploy the Workers

Once the secrets are in place:

```bash
cd backend
npx wrangler deploy --config wrangler.api.jsonc
npx wrangler deploy --config wrangler.mcp.jsonc
```

Smoke test:

```bash
curl https://lead-ace-api.<your-subdomain>.workers.dev/health
# → {"ok":true}

curl -o /dev/null -w "%{http_code}\n" \
  https://lead-ace-api.<your-subdomain>.workers.dev/api/projects
# → 401   (no auth — expected)
```

If you wired up a custom domain via the `routes` block in the wrangler
configs, check `https://api.<your-domain>/health` instead.

### 6. Deploy the frontend (Cloudflare Pages)

The frontend is a SvelteKit app served from Cloudflare Pages. Easiest
path is to create the project from the dashboard once and let CI take
over from there:

1. [Cloudflare Dashboard → Pages → Create a project](https://dash.cloudflare.com/?to=/:account/pages).
2. Project name: `lead-ace` (or anything — make sure CI uses the same
   name in `wrangler pages deploy --project-name`).
3. Production branch: `main`.
4. Build settings (only relevant if you connect to Git instead of
   uploading from CI):
   - Framework preset: SvelteKit
   - Build command: `npm run build`
   - Build output directory: `.svelte-kit/cloudflare`
   - Root directory: `frontend`
5. After the project exists, add `app.<your-domain>` under
   **Custom domains** if you want a branded URL.

Manual one-shot deploy from your laptop:

```bash
cd frontend
cp .env.example .env       # edit to point at your Workers + Supabase
npm install
npm run build
npx wrangler pages deploy .svelte-kit/cloudflare \
  --project-name lead-ace --branch main
```

The PUBLIC_* values are baked into the build at this step, so always
rebuild after changing them.

### 7. Marketing landing page (not included)

SurpassOne's marketing splash page (`landing/`) is **not** part of the
open-source distribution. You don't need it to run LeadAce — sign-in
works directly against the frontend (§6). If you want an apex-domain
landing page, build your own static site and deploy it as a separate
Cloudflare Pages project.

### 8. Optional: GitHub Actions CI/CD

The open-source mirror ships **no deploy workflow** — SurpassOne's
production pipeline (`deploy.yml`) is kept in a private repo so its
secrets and account wiring never live in public. The mirror only carries
`check.yml` (typecheck / lint / build). If you want push-to-deploy, add
your own workflow.

A minimal `.github/workflows/deploy.yml` for a self-host fork:

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      # Migrate (Session Pooler URL, port 5432)
      - run: cd backend && npm ci && npm run db:migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL_SESSION_POOLER }}
      # Workers
      - run: cd backend && npx wrangler deploy --config wrangler.api.jsonc
      - run: cd backend && npx wrangler deploy --config wrangler.mcp.jsonc
      # Frontend (PUBLIC_* are baked at build time)
      - run: cd frontend && npm ci && npm run build && npx wrangler pages deploy .svelte-kit/cloudflare --project-name lead-ace --branch main
        env:
          PUBLIC_API_URL: ${{ vars.PUBLIC_API_URL }}
          PUBLIC_MCP_URL: ${{ vars.PUBLIC_MCP_URL }}
          PUBLIC_SUPABASE_URL: ${{ vars.PUBLIC_SUPABASE_URL }}
          PUBLIC_SUPABASE_ANON_KEY: ${{ vars.PUBLIC_SUPABASE_ANON_KEY }}
          PUBLIC_LEADACE_EDITION: self-hosted
```

**Secrets** (`Settings → Secrets and variables → Actions → Secrets`):

| Name | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token scoped to Workers + Pages + KV (use the **Edit Cloudflare Workers** template). |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (Dashboard → right sidebar). |
| `DATABASE_URL_SESSION_POOLER` | Session Pooler URL (port 5432) used by the migrate step. |

**Variables** (`Settings → Secrets and variables → Actions → Variables`):

| Name | Value |
|---|---|
| `PUBLIC_API_URL` | `https://api.<your-domain>` (or `https://lead-ace-api.<sub>.workers.dev`). |
| `PUBLIC_MCP_URL` | `https://mcp.<your-domain>`. |
| `PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key. |

Keep `PUBLIC_LEADACE_EDITION: self-hosted` (the example above hard-codes
it). Only set it to `cloud` and add the `PUBLIC_STRIPE_PRICE_*` variables
if you actually run the paid-billing edition (§12).

### 9. Optional: Resend SMTP (custom auth email sender)

Supabase's default `noreply@mail.supabase.io` lands in spam often
enough that the hosted service uses Resend with a verified domain.
You only need this if Supabase's defaults aren't good enough for you.

1. Sign up at [resend.com](https://resend.com) and add your domain
   under **Domains**. Add the SPF / DKIM / DMARC records Resend prints
   to your DNS (turn off Cloudflare proxy for these — mail records
   can't be proxied).
2. Issue an API key (Sending access).
3. Supabase Dashboard → **Project Settings → Authentication → SMTP
   Settings**. Enable Custom SMTP with:
   - Host: `smtp.resend.com`, Port: `465`
   - Username: `resend`, Password: the API key
   - Sender email: `noreply@<your-domain>`
4. Update the email-template subjects/bodies under
   **Authentication → Email Templates** if you want them branded.
   The hosted service's templates live under `supabase/templates/` in
   this repo as a starting point.

### 10. Google Sign-in

The committed `/login` UI offers a "Continue with Google" button — and
since that UI is Google-only, this setup is required for a working
sign-in. To make it work:

1. [Google Cloud Console → APIs & Services → OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent).
   - User type: External (or Internal if you only need Workspace
     users in your org).
   - Authorised domains: your domain (you must own it; Search Console
     verification is required).
   - Move from Testing to Production once it works — Testing mode
     limits sign-ins to a hard-coded test-user list.
2. [APIs & Services → Credentials → OAuth client ID](https://console.cloud.google.com/apis/credentials).
   - Application type: Web application.
   - Authorised JavaScript origins: `https://app.<your-domain>`
     (and `http://localhost:5173` for dev).
   - Authorised redirect URIs:
     `https://<supabase-project-ref>.supabase.co/auth/v1/callback`.
     **Not** your `app.*.ai/auth/callback`. Supabase receives the
     `code` and redirects on to the app.
3. Supabase Dashboard → **Authentication → Providers → Google**.
   Paste the Client ID and Client Secret, save.

### 11. Optional: Gmail OAuth for outbound send

`/api/outreach/send-and-record` calls Gmail's `gmail.send` scope on behalf of the
signed-in user using a refresh token captured during the §10 sign-in
flow. The pieces wire together like this:

1. Add `https://www.googleapis.com/auth/gmail.send` to your Supabase
   Google provider's **Additional Scopes** field
   (Dashboard → Authentication → Providers → Google). Supabase asks
   for this scope at sign-in time, and Google returns a
   `provider_refresh_token` along with the access token.
2. Also add `gmail.send` to the OAuth consent screen's scopes in
   Google Cloud Console. This is a Sensitive scope — for production
   use you must complete Google's verification flow (a few weeks; you
   need to record a demo video and justify the scope). Until then,
   only the test users listed on your consent screen will be able to
   sign in. The Authorised redirect URI from §10
   (`https://<supabase-project-ref>.supabase.co/auth/v1/callback`) is
   the only one Google actually visits — there is no separate
   API-Worker callback, the frontend `/auth/callback` server handler
   forwards the refresh token to `/api/auth/google-credentials`.
3. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` /
   `GMAIL_TOKEN_ENCRYPTION_KEY` as wrangler secrets on the API Worker
   (already covered in §4).

If you skip this, sign-in still works and the rest of the platform is
fine; the outbound path then returns a graceful 412 "Gmail not
connected" — **provided** `UNSUBSCRIBE_TOKEN_SECRET` is set. The send
path HMAC-signs an unsubscribe link before it checks Gmail, so an empty
`UNSUBSCRIBE_TOKEN_SECRET` makes it fail with a 500 instead of the 412.
Set it (§4) even if you never enable outbound.

### 12. Optional: Stripe (cloud edition only)

If you actually want plan caps and a paid-billing UI in your fork,
flip `LEADACE_EDITION=cloud` (and `PUBLIC_LEADACE_EDITION=cloud`),
then:

```bash
cd backend
STRIPE_SECRET_KEY=sk_test_... \
PORTAL_RETURN_URL=https://app.<your-domain>/plans \
npx tsx scripts/setup-stripe.ts
```

The script creates idempotent Products / Prices / Customer-Portal
configuration (keyed by `metadata.app=lead-ace`) and prints six
`PUBLIC_STRIPE_PRICE_*=price_...` IDs you should set as GitHub
Variables. After your API Worker is deployed, re-run the script with
`WEBHOOK_URL=https://api.<your-domain>/api/stripe/webhook` to register
the webhook endpoint and capture the signing secret.

```bash
npx wrangler secret put STRIPE_SECRET_KEY     --config wrangler.api.jsonc
npx wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.api.jsonc
```

Most self-hosters will leave Stripe off entirely.

## Environment variables

### Backend (`backend/.dev.vars` for local; `wrangler secret` for production)

| Variable | Used by | Required? | Description |
|---|---|---|---|
| `DATABASE_URL` | API | yes | Postgres connection. **Transaction Pooler** URL (port 6543) in production. |
| `SUPABASE_URL` | API + MCP | yes | Supabase project URL. |
| `SUPABASE_JWT_SECRET` | API + MCP | yes | HS256 secret used by MCP to mint access tokens, and by API to verify them. Same value on both Workers. |
| `SUPABASE_ANON_KEY` | MCP | yes | Supabase publishable/anon key (used by the MCP OAuth handler). |
| `WEB_API_URL` | MCP | yes | URL of the API Worker (e.g. `https://api.<your-domain>`). |
| `APP_URL` | API | yes | URL of the frontend. Used in outbound-email links. |
| `FRONTEND_URL` | MCP | yes | URL of the frontend. Used by the OAuth handshake. |
| `ENVIRONMENT` | API + MCP | yes | `development` or `production`. |
| `LEADACE_EDITION` | API | no | `self-hosted` (default) or `cloud`. Anything other than `cloud` disables Stripe routes and runs every tenant on the unlimited tier. |
| `MCP_OAUTH_STORE` | MCP | yes | Cloudflare KV binding for OAuth state. Bound in `wrangler.mcp.jsonc` — replace the placeholder `id` with your own. |
| `GMAIL_TOKEN_ENCRYPTION_KEY` | API | for outbound | 32+ char passphrase. `pgp_sym_encrypt` key for stored Gmail tokens. |
| `UNSUBSCRIBE_TOKEN_SECRET` | API | for outbound | 32+ char passphrase. HMAC key for `/unsubscribe/:token` links — **never rotate** once emails have been sent. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | API | for outbound | OAuth refresh-token exchange for Gmail send. |
| `OPENAI_API_KEY` | API | for chat | Powers inquiry-chat. Chat is disabled if absent. |
| `GEMINI_API_KEY` | API | yes | Google AI Studio key (paid tier). Powers the daily org-signal refresh (Gemini + Google Search grounding). The daily cron fails without it. |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | API | cloud only | Required only when `LEADACE_EDITION=cloud`. Ignored otherwise. |

### Frontend (`frontend/.env` for local; GitHub Variables for production)

| Variable | Description |
|---|---|
| `PUBLIC_API_URL` | Public URL of the API Worker. |
| `PUBLIC_MCP_URL` | Public URL of the MCP Worker. |
| `PUBLIC_SUPABASE_URL` | Supabase project URL. |
| `PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key. |
| `PUBLIC_LEADACE_EDITION` | `self-hosted` (default) or `cloud`. Mirrors backend. Hides billing UI when not `cloud`. |
| `PUBLIC_STRIPE_PRICE_*` | Six Stripe Price IDs (starter/pro/scale × monthly/yearly). Only used when `PUBLIC_LEADACE_EDITION=cloud`. |

### Plugin

| Variable | Description |
|---|---|
| `LEADACE_MCP_URL` | Optional. Overrides the MCP server URL. Defaults to `https://mcp.leadace.ai/mcp`. Set to `http://localhost:8788/mcp` for local dev, or your self-hosted Worker URL in production. |

## Operational notes

- **Roll back a deploy**: Cloudflare Dashboard → Workers & Pages →
  the affected Worker → Deployments → "Rollback" on a previous build.
  Pages projects work the same way under Deployments.
- **Roll back the DB**: Supabase Dashboard → Database → Backups
  (daily snapshots on free tier).
- **Migrations**: `db:migrate` is idempotent — re-running is safe.
  Never edit a migration SQL file after it has been applied. If a
  migration is wrong, generate a new one that fixes it.
- **Daily cron**: The API Worker has a 03:00 UTC cron that refreshes
  organization signals across stale rows. It's defined in
  `wrangler.api.jsonc` and runs automatically once deployed.

## Licensing summary

The full text is in [LICENSE](../LICENSE). In short:

- **Self-hosting for your own organization** (you and your employees /
  contractors) — allowed.
- **Operating a multi-tenant service for third parties** — requires a
  commercial license from SurpassOne Inc. (contact
  leo.uno@surpassone.com).
- **Removing or modifying the LeadAce logo / copyright** in the
  `frontend/` or `landing/` directories — not allowed.

Otherwise the Apache 2.0 terms apply.
