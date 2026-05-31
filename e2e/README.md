# LeadAce local E2E harness

Run `/leadace` and other plugin skills directly with the host `claude` CLI
against a **local** LeadAce stack — local Supabase, local API/MCP Workers,
local frontend. The harness keeps its Claude state isolated under
`e2e/.claude-state/` so the developer's host-side `~/.claude` is left
alone, but everything else (Node, Python, the `claude` binary) runs on the
host.

## Strategy

- **Local stack on the host.** Supabase (Postgres + Auth) runs via the
  Supabase CLI; the API and MCP Workers run via `wrangler dev`; the
  frontend runs via `vite`.
- **Claude on the host with an isolated config dir.** `CLAUDE_CONFIG_DIR`
  points at `e2e/.claude-state/`, a gitignored directory the harness
  scripts create. Subscription login state and the LeadAce MCP refresh
  token persist there across runs, and your usual host-side Claude state
  is untouched.
- **Staged plugin with a localhost-pinned `.mcp.json`.** Every script
  rsyncs `plugin/` into `e2e/.plugin-staging/` (gitignored) and overwrites
  the staged `.mcp.json` to point at `http://localhost:8788/mcp`. Claude
  Code's plugin loader only does `${user_config.KEY}` substitution; it
  does NOT expand `${ENV_VAR}` or `${VAR:-default}`, so the production
  default in `plugin/.mcp.json` would otherwise win even with
  `LEADACE_MCP_URL` exported. Staging sidesteps this by having bash write
  the URL into the staged file, leaving Claude with a plain literal.
  `LEADACE_MCP_URL=...` still works as an override at staging-build time.
- **Real Google OAuth, real Supabase Auth.** No backdoor or mock auth
  paths in the production code. The cost is a one-time setup of a Google
  Cloud OAuth client; the win is that what the harness exercises and what
  a self-host install exercises are the same code path.

The previous Docker-based harness was abandoned because Claude Code's MCP
OAuth callback server binds to `127.0.0.1` only, which Docker's loopback
publish (`127.0.0.1:HOSTPORT:CONTAINERPORT`) cannot reach without a socat
sidecar. The host-direct flow makes the callback land where the host
browser already expects it.

## What this catches

- Skill loading (frontmatter, `allowed-tools`, reference links valid)
- Skill chain orchestration (`/leadace <URL>` correctly delegates
  onboarding → strategy → daily-cycle)
- MCP tool wiring (every tool the skill calls exists, has the expected
  schema, and the backend accepts the payload)
- The OAuth-2.1 dance between Claude Code, the MCP Worker, and Supabase
  Auth, against the same code paths a self-host install runs

## What this does NOT catch (yet — Phase 2 scope)

- Daily-cycle and reply-detection scenarios (the recipient redirect below
  is the building block; the scripts that drive those flows haven't
  landed yet)
- Real-Gmail outbound happy path against `E2E_RECIPIENT_OVERRIDE` (the
  refusal branches and draft mode are covered curl-only by
  `regression-outbound.sh` below; the real-send branch requires a Gmail
  OAuth on the test account and is still on the Phase 2 todo list)
- Plan-tier quota enforcement (the `self-hosted` edition resolves every
  tenant to `unlimited`; quota tests need a `cloud`-edition stack with
  a manual `subscriptions` row)
- Headless browser side effects (`claude-in-chrome`)
- Stripe webhook handling

The 0.5.91 dedup flow is covered separately by
`./e2e/regression-build-list-dedup.sh` — see "Build-list dedup regression"
below. The send-and-record refusal/draft branches are covered by
`./e2e/regression-outbound.sh` — see "Outbound regression" below. Both
are curl-only, don't need a Claude session, and run fast.

## Recipient redirect for real Gmail sends

Setting `E2E_RECIPIENT_OVERRIDE=<test-mailbox@example.com>` in
`backend/.dev.vars` makes every Gmail-send call rewrite `To:` / `Cc:` /
`Bcc:` to that single mailbox and stash the originals in an
`X-E2E-Original-To` header. With this set, harness scenarios that send
real Gmail (outbound, lead notifications, etc.) drive the production
send path end-to-end without ever touching real prospects. Unset is the
production default — a no-op, same code path the live worker takes.

Restart `wrangler dev` after editing `.dev.vars` so the new env propagates.

## Pre-requisites

- Claude Code CLI on `PATH` (`claude --version` works)
- An Anthropic subscription account (Claude Pro / Max / Team) for the
  Claude Code login
- Node.js 22+, the Supabase CLI, and the local stack running on the
  host (see [docs/self-host.md](../docs/self-host.md) → Local development)
- A Google Cloud OAuth client wired into local Supabase (one-time, see
  below). Same client you'd configure for any other self-host install
  — the harness adds no extra requirement.

## One-time setup

1. **Bring up the local stack** on the host (one terminal each, or use
   tmux / multiple panes):

   ```bash
   npx supabase start                      # Auth + Postgres
   cd backend && npm run dev:api           # → http://localhost:8787
   cd backend && npm run dev:mcp           # → http://localhost:8788
   cd frontend && npm run dev              # → http://localhost:5173
   ```

   Refer to [docs/self-host.md](../docs/self-host.md) for the full env
   setup (`.dev.vars`, `frontend/.env`, the seed SQL for
   `master_documents`).

2. **Configure the Google OAuth provider** for local Supabase Auth.
   This is the same setup any self-hoster needs and is documented in
   [docs/self-host.md → Local development](../docs/self-host.md#local-development);
   follow the Google OAuth subsection there. Persist the
   `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/SECRET` env vars (e.g. via
   `direnv` — `.envrc.example` at the repo root is the template) so
   future `npx supabase start` invocations pick them up without manual
   re-export.

3. **Initialize the harness** (subscription login + LeadAce MCP OAuth in
   one interactive Claude session, state persisted to the gitignored
   `e2e/.claude-state/`):

   ```bash
   ./e2e/setup.sh
   # Inside the resulting interactive Claude session:
   #   /login              # if not logged in yet — sign in via browser
   #   /leadace overview     # triggers the LeadAce MCP OAuth flow
   #     ★ Verify the printed URL is http://localhost:8788/authorize?...
   #       NOT https://mcp.leadace.ai/authorize?... — staging pins to local;
   #       seeing the production host means staging is broken.
   #     ... sign in with Google, click Allow ...
   #     ... browser → http://localhost:47291/callback?... → success ...
   #     /leadace overview continues and lists local projects (empty on a fresh DB).
   #   /exit
   ```

   After this, the subscription session and MCP refresh token are stored
   in the state dir; later `./e2e/run.sh` and `./e2e/smoke.sh` invocations
   skip the auth dance. Re-run `setup.sh` after a `wrangler dev` restart
   (in-memory KV is lost so MCP refresh tokens become invalid) — `/login`
   will be a no-op and only the MCP OAuth dance redoes.

## Running

### Preflight

Before running smoke, verify the local stack is up:

```bash
./e2e/preflight.sh
```

The script checks Supabase Auth, the API Worker, the MCP Worker, the
frontend, and that the `claude` CLI is on `PATH`. It exits non-zero on
any failure.

### Standard onboarding-chain smoke

```bash
./e2e/smoke.sh                       # default URL: https://example.com
./e2e/smoke.sh https://leadace.ai    # custom URL
SKIP_CLEANUP=1 ./e2e/smoke.sh        # keep the project for manual inspection
```

`smoke.sh` runs `/leadace <url>` headless with a prompt that pre-resolves
every interactive Q&A (`env_check` defaults to `unsure`, sender values are
placeholders, no outreach is sent). It parses the project id printed on
the last line of the result and runs `/delete-project <id>` to leave the
local tenant clean. JSON outputs go to `e2e/output/smoke-leadace-*.json`
and `smoke-cleanup-*.json`. Exit codes: `0` all good, `1` `/leadace`
failed, `2` couldn't parse project id, `3` cleanup failed.

### Build-list dedup regression (curl-only, no Claude)

```bash
./e2e/regression-build-list-dedup.sh
SKIP_CLEANUP=1 ./e2e/regression-build-list-dedup.sh
```

Curl-driven regression for the 0.5.91 dedup flow. Mints its own JWT via
`mint-jwt.sh` (HS256 against the local `SUPABASE_JWT_SECRET`), creates a
throwaway project, exercises:

- `POST /prospects/check-dedup` (the build-list Phase 1.5 pre-flight)
- `normalizeDomain` parity on both `prospectInputSchema` and
  `dedupCandidateSchema`
- All `DedupSkipReason` variants: `do_not_contact`, `email_duplicate`,
  `form_url_duplicate`, `already_in_project`, `duplicate_in_batch`
- `/prospects/check-dedup` ↔ `/prospects/batch` parity (the read-only
  pre-flight must agree with the actual write path on what's fresh)
- The 100-candidate cap (101 → 400)

Cleans up by deleting the test projects and dropping any tenant-scoped
prospects/organizations whose domain matches the run tag (`e2e-dedup-<ts>-`)
via direct psql against the local DB. Doesn't burn Anthropic budget — no
Claude session involved.

### Outbound regression (curl-only, no Claude)

```bash
./e2e/regression-outbound.sh
SKIP_CLEANUP=1 ./e2e/regression-outbound.sh
```

Curl-driven regression for `POST /api/outreach/send-and-record` — the
endpoint every outbound channel funnels through. Snapshots the tenant's
current compliance settings, mints a JWT, creates a throwaway project,
and exercises:

- **Compliance gate** — clears `legal_name` / `physical_address` /
  `default_sender_country`, asserts the call returns 412 with all three
  field names in the `missing[]` extra.
- **Draft happy path** — sets `outboundMode='draft'`, posts a send, asserts
  201 with `mode='drafted'`, the `outreach_logs` row lands as
  `pending_review`, and `/api/projects/:id/drafts` surfaces it.
- **Country guardrail** — flips to send mode, posts for a `country='GB'`
  prospect, asserts 422 `Recipient country GB is not supported` *before*
  any optimistic INSERT (no `outreach_logs` row allocated).
- **Gmail-dependent branch (one of two, depending on local state):**
  - When `gmail_credentials` has no row for the test tenant: posts a US
    prospect in send mode, asserts 412 `Gmail not connected` and that
    the rolled-back path leaves no `status='sent'` row behind.
  - When the tenant has Gmail connected AND `E2E_RECIPIENT_OVERRIDE` is
    set in `backend/.dev.vars`: real-send happy path. Asserts the
    response shape (`mode='sent'`, message/thread ids), the
    `outreach_logs` row stamped `status='sent'`, and the
    `project_prospects` row flipped to `contacted`. The recipient
    override forces the wire-level `To:` to the test mailbox so this
    never reaches a real prospect.

The script never deletes `gmail_credentials` — your Gmail connection
survives every run, and the no-Gmail branch only fires when the row was
already absent. To cover both branches, run once before connecting
Gmail and again after.

Tenant compliance fields are restored from the snapshot on exit (`trap
EXIT`); the local stack returns to whatever state it was in before the
run. `SKIP_CLEANUP=1` skips both the project delete and the tenant
restore — useful when an assertion fails and you want to inspect the
DB.

The real-send branch only asserts the API + DB stamps; it does not
verify the test mailbox actually received the email. Check that
manually if you want end-to-end confirmation. See "Recipient redirect
for real Gmail sends" above for how the override works.

### Triggering Cloudflare cron jobs

`wrangler dev` does not fire scheduled triggers automatically. `npm run
dev:api` starts the API Worker with `--test-scheduled`, which exposes a
`/__scheduled` endpoint that fires the `scheduled` handler on demand:

```bash
./e2e/trigger-cron.sh                  # fires the daily org-signals refresh
./e2e/trigger-cron.sh "*/5 * * * *"    # custom cron spec
curl 'http://localhost:8787/__scheduled?cron=0+3+*+*+*'   # raw equivalent
```

Watch the API Worker terminal for `[scheduled] org-signals refresh` log
lines. The handler runs against the local DB only; the per-run cap inside
`runDailySignalRefresh` keeps a wide tenant from spinning forever.

### Arbitrary scenarios

```bash
./e2e/run.sh "<claude prompt>"
```

`MAX_BUDGET_USD` overrides the `--max-budget-usd` cap (default `1.50`).

The wrapper passes:

- `--plugin-dir $REPO_ROOT/e2e/.plugin-staging` — load the LeadAce plugin
  from the staged copy (refreshed on every run via rsync, with
  `.mcp.json` rewritten to point at the local MCP Worker). Coexists fine
  with a marketplace-installed copy in your normal `~/.claude/`.
- `--add-dir $REPO_ROOT` — allow tool access to the repo
- `--settings $REPO_ROOT/e2e/settings.json` — minimal allowlist for
  `mcp__api__*` and shell utilities
- `--setting-sources user` — ignore the project-level `.claude/settings.json`
  so the harness is isolated
- `--permission-mode dontAsk` — respect the allowlist; deny everything
  else without prompting
- `--max-budget-usd $MAX_BUDGET_USD` — cap per run (this is an
  API-equivalent figure, not a real charge when logged in via subscription)
- `--output-format json` — structured output for assertions
- `--no-session-persistence` — clean run, no session pollution

Output JSON is emitted to stdout. Capture it with
`> e2e/output/run-$(date +%s).json` to inspect later.

### A note on cost

`total_cost_usd` in the JSON output is the API-equivalent value calculated
from token usage, *not* a charge. When logged in via a Claude subscription
(Pro/Max/Team), running `claude` consumes the subscription's rate quota
and is not billed per token. The harness explicitly relies on subscription
auth (no `ANTHROPIC_API_KEY` is exported) so `total_cost_usd` reads as
informational only.

## Cleanup

```bash
# Wipe the harness state (forces re-running setup.sh on next run).
rm -rf e2e/.claude-state

# Wipe the staged plugin too (auto-rebuilt on next script invocation).
rm -rf e2e/.plugin-staging
```

For per-test cleanup, the smoke script already does it. For arbitrary
runs, delete the project that the run created via
`/delete-project <id>`. To reset the entire local DB (e.g. after a
schema change), run `npx supabase db reset` on the host.

## Known gaps

- **MCP OAuth refresh in dev mode.** The local MCP Worker uses the same
  30-day sliding refresh-token TTL as production, so the harness should
  rarely need re-authorizing. If `wrangler dev`'s in-memory KV is reset
  (Worker restart), refresh tokens are lost and you'll need to re-run
  `./e2e/setup.sh` (only the `/leadace overview` MCP OAuth step needs redoing —
  `/login` is a no-op once the subscription session is cached). This is
  a `wrangler dev` limitation, not a LeadAce limitation.
- **`MCP_OAUTH_CALLBACK_PORT` collision.** The harness pins the OAuth
  callback to `127.0.0.1:47291` so it's documentable. If something else
  on your host already binds that port, override it via
  `MCP_OAUTH_CALLBACK_PORT=<port> ./e2e/setup.sh`.
