---
name: local-e2e
description: "Local LeadAce E2E testing skill. Triggers: 'local E2E', 'ローカル E2E', 'local-e2e', 'E2E テスト', E2E run against the local stack. Encodes the prerequisites: host-side `claude` CLI, real Google OAuth, local Supabase / Workers / Frontend. Concrete scenarios are user-supplied per run."
---

# Local E2E test skill

Drive the local stack (Supabase / API Worker / MCP Worker / Frontend) from the host `claude` CLI, isolated under `CLAUDE_CONFIG_DIR=$REPO_ROOT/e2e/.claude-state`, against user-supplied scenarios.

The plugin is rsynced to `e2e/.plugin-staging/` on every run with the staged `.mcp.json` URL hard-coded to `http://localhost:8788/mcp` and loaded via `--plugin-dir`. Claude Code's plugin loader only expands `${user_config.KEY}`, not `${ENV_VAR:-default}`, so an env-var override on the original `plugin/.mcp.json` would not take effect; the staging step writes the literal URL instead. `LEADACE_MCP_URL=...` still works as an override at staging-build time.

Concrete test scenarios come from the user. This skill captures the **prerequisites, run procedure, and cleanup** needed to drive them safely.

## Core principles

- **Never touch production.** `api.leadace.ai` / `mcp.leadace.ai` / the production Supabase project are off-limits. Everything runs against the local stack.
- **Don't bypass OAuth.** Google OAuth, Supabase Auth, and MCP OAuth all run their real flows. No test-only backdoors in the codebase (so self-host installs run the same code path).
- **Local DB is fair game**, but be careful not to clobber another in-flight workspace. Reset with `npx supabase db reset`; reseed `master_documents` with `cd backend && npx tsx scripts/seed-master-documents.ts`.
- **Don't touch host-side Claude state.** The harness uses `$REPO_ROOT/e2e/.claude-state/` as `CLAUDE_CONFIG_DIR` and never writes to `~/.claude/`.

## Pre-flight checks

The local stack must be running on the host:

| Service | Start command | Health check |
|---|---|---|
| Supabase Auth (54321) + Postgres (54322) | `npx supabase start` | `curl http://localhost:54321/auth/v1/health` |
| API Worker (8787) | `cd backend && npm run dev:api` | `curl http://localhost:8787/health` |
| MCP Worker (8788) | `cd backend && npm run dev:mcp` | `curl http://localhost:8788/.well-known/oauth-authorization-server` |
| Frontend (5273) | `cd frontend && npm run dev` | `curl http://localhost:5273` |
| Claude CLI | (host install) | `claude --version` |

`./e2e/preflight.sh` runs all five at once and prints a `FAIL:` line for any missing piece.

## One-time setup

Detailed harness setup lives in [`e2e/README.md`](../../../e2e/README.md). The skeleton:

1. In Google Cloud Console, create a Web OAuth client and add `http://localhost:54321/auth/v1/callback` to its redirect URIs.
2. Export `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID/SECRET`, then `npx supabase stop && start` (persist via `direnv` + `.envrc` — `.envrc.example` lives at the repo root).
3. Put the same values in `backend/.dev.vars` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Run `./e2e/setup.sh` to populate the harness state dir with a Claude Code login + the LeadAce MCP OAuth grant:
   - `/login` (sign in via browser if not already)
   - `/leadace overview` (★ verify the OAuth dance URL is `http://localhost:8788/authorize`, click Allow, browser lands on `127.0.0.1:47291/callback`)
   - `/exit`

State persists in `e2e/.claude-state/` (gitignored), so subsequent runs skip the dance. After a `wrangler dev` restart, MCP refresh tokens are lost with the in-memory KV — re-run `setup.sh` (`/login` is a no-op, `/leadace overview` redoes the MCP OAuth only).

## Running

### 0. Standard smoke (onboarding chain)

A one-shot wrapper that runs `/leadace` end-to-end (intent classification + env_check Mode B + strategy_drafting Mode B + 4B-4 summary) and auto-cleans the project it created:

```bash
./e2e/smoke.sh                       # default URL: https://example.com
./e2e/smoke.sh https://leadace.ai    # custom URL
SKIP_CLEANUP=1 ./e2e/smoke.sh        # keep the project for manual inspection
```

Behavior:
- Prompts include "no interactive Q&A available, sensible defaults, do not send outreach" so the run is headless.
- The `/leadace` result ends in `PROJECT_ID=<id>`; the shell parses it.
- Unless `SKIP_CLEANUP=1`, the wrapper invokes `/delete-project <id>` to leave the tenant clean.
- Output JSON: `e2e/output/smoke-leadace-*.json` and `smoke-cleanup-*.json`.
- Exit codes: 0 = all OK, 1 = `/leadace` failed, 2 = couldn't parse PROJECT_ID, 3 = cleanup failed.

The harness budget defaults to `--max-budget-usd 1.50` (`MAX_BUDGET_USD` env override). **The cost figure is an API-equivalent reference under subscription auth, not a real charge** — it consumes Claude Pro/Max/Team rate quota only.

### 1. Worker log tail (optional, side-by-side)

`smoke.sh` does not read Worker logs. For bug investigations or behavior deep-dives, tail in a separate terminal: each `wrangler dev` window already prints HTTP method / path / status / Worker logs. Request IDs make API ⇔ MCP correlation easy to eyeball.

### 2. Arbitrary scenario runs (when `smoke.sh` is too narrow)

```bash
./e2e/run.sh "<prompt>"
```

Examples:

```bash
./e2e/run.sh "/leadace https://example.com"
./e2e/run.sh "/daily-cycle <project-id>"
```

Phrasing the prompt so it includes "no interactive Q&A is available" pushes the agent toward defaults — `smoke.sh`'s prompt is a good template. Output JSON streams to stdout; capture with `> e2e/output/run-$(date +%s).json` if you want to keep it.

### 3. DB inspection

The local Postgres is reachable at `psql 'postgresql://postgres:postgres@localhost:54322/postgres'`. Supabase Studio UI: `http://localhost:54323`.

```sql
-- Recent outreach
SELECT id, project_id, prospect_id, status, sent_at, error_message
  FROM outreach_logs ORDER BY sent_at DESC LIMIT 10;

-- Prospect status distribution for one project
SELECT status, COUNT(*) FROM project_prospects
  WHERE project_id = '<project-id>' GROUP BY status;

-- Test accounts
SELECT id, email FROM auth.users ORDER BY created_at DESC LIMIT 5;
```

The local DB is not the production DB — SELECT / UPDATE / DELETE are fair game without per-operation approval. Production-DB operations still require the standard per-operation user approval, but that path doesn't enter this skill.

### 4. Triggering Cloudflare cron jobs

`wrangler dev` does not fire scheduled triggers automatically. The API Worker is started with `--test-scheduled`, which exposes a `/__scheduled` endpoint that fires the `scheduled` handler on demand:

```bash
./e2e/trigger-cron.sh                  # fires the daily org-signals refresh
curl 'http://localhost:8787/__scheduled?cron=0+3+*+*+*'   # raw equivalent
```

Watch the API Worker terminal for `[scheduled] org-signals refresh` log lines. The handler runs on the local DB only and respects the per-run cap inside `runDailySignalRefresh`.

### 5. Cleanup

To delete a single project: invoke `/delete-project <id>` via Claude (`smoke.sh` does this automatically).

To wipe the local DB end-to-end:

```bash
npx supabase db reset
cd backend && npx tsx scripts/seed-master-documents.ts
```

To reset the harness Claude state (forces re-login):

```bash
rm -rf e2e/.claude-state
```

## Troubleshooting

- **`./e2e/preflight.sh` fails with `FAIL: API Worker` (or similar):** the named service isn't running on the host. Start it from the table above.
- **`/authorize` returns 500 during `./e2e/setup.sh`:** the MCP Worker likely has env vars missing. Check `backend/.dev.vars` for `SUPABASE_JWT_SECRET` / `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `WEB_API_URL`.
- **Google consent screen says `redirect_uri_mismatch`:** the Web OAuth client in Google Cloud Console lacks `http://localhost:54321/auth/v1/callback`.
- **After `wrangler dev` restart Claude says `MCP needs authorization`:** the local MCP KV is in-memory and didn't survive the restart. Re-run `./e2e/setup.sh` (only the `/leadace overview` MCP OAuth step needs redoing).
- **`MCP_OAUTH_CALLBACK_PORT` collides with another process:** override with `MCP_OAUTH_CALLBACK_PORT=<port> ./e2e/setup.sh`.
- **Host-side `claude` is reading the harness state:** check that `CLAUDE_CONFIG_DIR` isn't still exported in the shell you're invoking `claude` from. Going through `./e2e/*.sh` always isolates correctly.
- **`/leadace overview` lists unfamiliar / production-looking projects:** either staging is stale, or `e2e/.claude-state` retains an old production OAuth refresh token. `rm -rf e2e/.claude-state e2e/.plugin-staging` and redo `./e2e/setup.sh`. During the OAuth dance, confirm the URL begins with `http://localhost:8788/authorize`.

## Do not

- Add `--dangerously-skip-permissions` (or any other safety bypass) to harness scenarios.
- Leave `LEADACE_MCP_URL` pointed at production (`https://mcp.leadace.ai/mcp`); the harness defaults to `localhost:8788`, but env overrides are honored.
- Commit `accounts.local.json` (the `*.local.json` ignore covers it, but be explicit).
- Commit `e2e/.claude-state/` (covered by `e2e/.gitignore`).

## Coverage status

Curl-only regressions (no Claude session, no Anthropic budget) — run all via
`./e2e/regression-all.sh`, or each individually:

- ✅ **`regression-build-list-dedup.sh`** — `check_prospect_dedup` + Phase 1.5 + normalize-domain.
- ✅ **`regression-outbound.sh`** — `send-and-record`: compliance gate, draft mode, country guardrail, real-Gmail send (redirected to `E2E_RECIPIENT_OVERRIDE`).
- ✅ **`regression-skip-reachable.sh`** — `skip_prospect` ('skipped' audit row, all reasons) + `listReachable` candidate-stage country filter (US/CA/JP/NULL admitted, GB excluded).
- ✅ **`regression-followup-sequence.sh`** — P1 day-scale follow-up: seed/advance via `markProspectContacted`, the `listReachable` follow-up arm (`short_cycle_followup` / `touchNumber`), reply stop-wiring, the enabled=false kill-switch + effective-disabled (omitted-`enabled`) clear, and the disabled/no-backfill path.

Onboarding chain is covered by `./e2e/smoke.sh` (drives the Claude CLI; needs a live MCP grant).

Still Phase 2 (not yet implemented):

- **daily-cycle full run** — chain check-responses → evaluate → outbound + build-list end-to-end.
- **Reaction detection automation** — either plant replies in a test mailbox so `/check-responses` can pick them up, or substitute the inquiry-landing webhook path.

## Related resources

- Harness internals: [`e2e/README.md`](../../../e2e/README.md)
- Local dev setup: [`docs/self-host.md`](../../../docs/self-host.md) → Local development
- Plugin skill catalog: `plugin/skills/`
