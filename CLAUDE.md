# LeadAce Plugin Development Repository

Repository for LeadAce — an autonomous sales automation Claude Code plugin by SurpassOne Inc.

## Repository Structure

```
.claude-plugin/marketplace.json  # Marketplace definition (source: "./plugin/")
plugin/                          # Claude Code plugin
backend/                         # Web API Server + MCP Server
frontend/                        # Web frontend
docs/                            # Project-wide docs (deploy runbook, self-host, tasks)
docker-compose.yml               # Local development environment
```

## Plugin Structure

```
plugin/
├── .claude-plugin/
│   └── plugin.json       # Plugin manifest (required)
├── .mcp.json             # MCP server configuration (LeadAce backend)
├── skills/                # Skills (each subdirectory has SKILL.md, invoked as `/<name>`)
├── scripts/               # Local utility tools (fetch_url.py)
└── references/            # Shared reference documents
```

Project-wide design docs, runbooks, and task tracking live in the top-level `docs/` directory, not under `plugin/`. Anything that is not specifically about the plugin's runtime structure (Workers, Pages, Stripe, Supabase, session-level task tracking, architecture history, etc.) belongs there.

Plugin / skill authoring conventions live in [.claude/rules/plugin-development.md](.claude/rules/plugin-development.md) (auto-loaded when files under `plugin/` are touched). For fundamentals not specific to LeadAce, consult `/skill-development` and `/plugin-structure`.

## Development Policy

The plugin prioritizes **stability, reliability, controllability, and versatility**.
- Do not hard-code values that depend on specific businesses or use cases (target numbers, success rates, etc.) into skills or templates
- Defer business-specific decisions to project configuration (stored as documents in the DB: business, sales_strategy, etc.); the plugin provides control mechanisms and visibility
- Improve skills by increasing user control, not by enforcing specific behavior
- MCP tool surface: liberal with read tools, conservative with write/action tools. A destructive tool needs a read counterpart so the agent can preview what it is about to touch (`list_drafts` → `discard_drafts`)

### Design Principles

- **Explore wide, output narrow**: when investigating, brainstorming, or thinking, cast a wide net across angles. When producing output (docs, design, code), cut to the minimum that carries the conclusion. "Just in case" and "might as well note this" filler doesn't get read, buries the important parts, and breeds inconsistency over time — pure cost, no upside.
- **Keep specs simple**: Default to the simplest spec that solves the problem. Extra conditional branches accrue as technical debt more often than they pay back as value — add one only when it encodes a real, distinct case.
- **Encapsulate spec boundaries**: Each module / layer / skill should expose its responsibility through a narrow contract. Callers must not need to reason about its internals to use it correctly.
- **Think before coding**: state assumptions explicitly. If multiple interpretations exist, present them — don't pick silently. If unclear, stop and ask. If a simpler approach exists, push back.
- **Surgical changes**: touch only what you must — every changed line should trace to the request. Don't "improve" adjacent code, don't refactor what isn't broken, match existing style. Mention unrelated dead code; don't delete it. Remove orphans your changes created.

### Separation of Responsibilities: LLM vs MCP Tools

Clearly separate what the LLM should handle from what MCP tools handle.

- MCP tools (deterministic logic): DB operations (prospect registration, outreach logging, status updates, prospect-priority overrides, document storage), data queries (prospect identifiers, outbound targets, evaluation stats, document retrieval), master document retrieval via `get_master_document` — operations where rules are clear and behavior should be consistent every time. The server handles validation, deduplication, and status management
- Local tools: email sending (`gog` CLI), form submission (`playwright-cli`), SNS DMs (`claude-in-chrome`), web page fetching (`fetch_url.py`) — operations requiring local environment access
- LLM (judgment & generation): context-dependent judgment and natural language — drafting email bodies, evaluating prospects, analyzing/improving strategy, merging/deduplicating candidate data

Design tools so the plugin never has to reason about state consistency. Each MCP tool is a thin 1:1 wrapper over one backend endpoint (`src/mcp/` does only response formatting — no business logic or state orchestration; project name-or-id resolution happens server-side in the API), so this is really an API-design rule: a data-mutating endpoint performs the action *and* applies every consequent state update atomically. The plugin then calls one simple, self-contained tool — never a multi-tool sequence in a fixed order — to keep data consistent. Canonical example: `send_email_and_record`.

## Plan Tiers & Limits

Subscription is managed via Stripe. The API enforces limits based on user plan.

| | Free | Starter $29/mo | Pro $79/mo | Scale $199/mo |
|---|---|---|---|---|
| Projects | 1 | 1 | 5 | Unlimited |
| Outreach actions | 5/day (50 lifetime cap) | 1,500/mo | 10,000/mo | Unlimited |
| Prospect registration | 500 (lifetime) | — | — | — |

- Free has two outreach caps: `5/day` AND `50 lifetime`. Whichever runs out first blocks send. Paid plans use a single monthly cap that resets at the Stripe `current_period_start`.
- Daily window is UTC midnight-to-midnight (no per-tenant timezone).
- Outreach action = `record_outreach` with `status: "sent"`. Failed attempts don't count.
- Quota enforcement: `get_outbound_targets` returns `min(requested, remainingQuota, availableTargets)` where `remainingQuota` is the smallest remaining across all applicable windows. When 0, returns empty list with a constraint-specific message ("try again tomorrow" for daily, "upgrade" for lifetime/monthly). `record_outreach` and `/outreach/send-and-record` guard as a safety net.
- Billing: Stripe Checkout for new subs, Stripe Customer Portal for changes/cancel. No billing UI in our app.
- Self-host: code is open source. Users run their own Supabase + Cloudflare deploy (see [docs/self-host.md](docs/self-host.md)). Same plan-limits code runs; defaults to Free.

## Multi-Tenancy

All data is isolated by tenant. Every tenant-scoped table carries a `tenant_id` column, queries always filter on it, and RLS enforces the isolation at the DB level. See [.claude/rules/backend-architecture.md](.claude/rules/backend-architecture.md) for the schema (tables, role, middleware) and conventions (where `createDb()` is allowed to bypass RLS).

## Development Rules

- Language: English (both code comments and documentation)
- **Types express the spec**: design types so invalid states cannot be constructed. `any` is prohibited (see Backend TypeScript Rules). When behavior depends on a runtime check, encode it in the type (discriminated union, branded type, narrowed return) instead of leaving it implicit
- **Don't reach for `null` / `undefined` reflexively**: each optional field multiplies the states callers must handle. Before adding one, ask: is the value truly absent sometimes, can a sensible default replace it, or should the type be split into variants where each variant has the field present? Use optionality only when absence is a real, distinct state
- **DB columns: NOT NULL by default** — make a column nullable only when `null` is a genuinely distinct state. A nullable column tends to cascade into "what if the whole row is absent" assumptions across every reader, and that assumption is much harder to retract later than to avoid up front
- **Stick to the orthodox path**: prefer the boring, obvious implementation over a clever one. Code should read top-to-bottom without the reader having to reconstruct hidden context
- **State names match reality, no double-duty columns**: don't overload a status / state field to carry a feature requirement (e.g., flipping `prospect.status` to `contacted` only to keep get_outbound_targets from re-picking a draft). Express the feature requirement on a separate axis (a derived query like `NOT EXISTS`, a separate column, an additional enum value) so the original state keeps its real-world meaning
- **Testing philosophy**: rely on the type system (TypeScript strict, Zod schemas, drizzle's typed builder) as the first line of defense — anything the types can already guarantee is NOT tested. On top of that, the backend keeps a **minimal, coarse-grained** unit-test layer (Vitest, co-located `*.test.ts`) that covers only **pure business logic types cannot express**: branching / state transitions, arithmetic, ordering / tie-breaks, parsing, dedup / normalization, threshold decisions — where getting it wrong has real consequences. Where such logic is trapped inside a DB-coupled service function, extract the pure core (to `domain/`, or as an exported pure helper) and test that. Do NOT test routes, drizzle queries, or DB I/O via mocks — those stay covered by the `e2e/regression-*.sh` curl harness. Don't chase exhaustive per-endpoint coverage. Full standard: [.claude/rules/backend-architecture.md](.claude/rules/backend-architecture.md) § Testing
- **Comments**: default to none. Write one only when *why* is non-obvious, and keep it brief. If code needs a comment to be readable, restructure it

## Backend Development (backend/)

### Architecture

3-layer pattern: `routes/` (HTTP adapter) → `services/` (orchestration + DB I/O) → `domain/` (pure functions). No repository layer — drizzle is the typed query builder. See [.claude/rules/backend-architecture.md](.claude/rules/backend-architecture.md) for the full standard (dependency rules, transaction conventions, Hono/drizzle gotchas). Reference implementation: `backend/src/api/routes/responses.ts` + `backend/src/services/responses.ts` + `backend/src/domain/{prospect-status,rejection-feedback}.ts`.

### DB Schema Changes

Never write migration SQL by hand. `backend/src/db/schema.ts` is the single source of truth.

Never edit a migration SQL file after it has been applied (local, staging, or prod). Once a `drizzle/NNNN_*.sql` is applied anywhere, treat it as immutable — if behavior needs to change, generate a new migration. Editing applied files drifts the committed file from actual DB state and the hashes in `drizzle.__drizzle_migrations` no longer match. Recovery requires manual SQL surgery on prod.

Local dev flow:

```bash
# 1. Edit backend/src/db/schema.ts
# 2. Auto-generate migration SQL from the diff
cd backend && npm run db:generate
# 3. Apply to local DB
npm run db:migrate
# 4. Commit schema.ts + drizzle/ together
```

Production: `db:migrate` runs via the `migrate-db` job in `.github/workflows/deploy.yml` on every `main` push (idempotent — drizzle tracks applied migrations). The job uses `DATABASE_URL_SESSION_POOLER` (Session Pooler, port 5432); Transaction Pooler (6543) breaks DDL like `CREATE ROLE`.

When a migration adds a new tenant-scoped table, append `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO app_rls;` to the generated SQL. `0001_rls_policies.sql`'s `ALTER DEFAULT PRIVILEGES` only covers objects created by the role that ran it — a migration applied by another role (e.g., hand-run via the Supabase SQL editor) silently skips the grant and runtime hits "permission denied for table …". The belt-and-braces grant is idempotent.

### TypeScript Rules (backend/)

- `any` is prohibited. Use proper types or fix the design.
- After modifying backend TypeScript, run `cd backend && npm run typecheck` before committing.
- Zod is v4. Use top-level `z.email()` / `z.url()` / `z.uuid()` etc. for string-format validation. `z.string().email()` / `.url()` are deprecated.
- For partial-update upsert endpoints (`PUT /xxx`), do not pre-load the row to merge with the patch. Set `INSERT` values from `patch ?? DEFAULTS` and `onConflictDoUpdate.set` to only the columns the caller explicitly provided (conditional spread). The pre-load + merge approach is racy: two concurrent PUTs read the same `existing`, each merges its own patch, and the loser's untouched columns clobber the winner's. See `backend/src/api/routes/project-settings.ts` PUT handler for the canonical shape.

### Local Dev

```bash
make dev                   # or ./scripts/dev.sh — Supabase + migrate + seed +
                           # API (:8787) + MCP (:8788) + frontend (:5173).
                           # Ctrl-C stops the dev servers; `make stop` halts Supabase.
```

`scripts/dev.sh` is the orchestrator; the Makefile is a thin wrapper. Supabase
stays on the Supabase CLI (it is already Docker and is coupled to
`supabase/config.toml`); the Workers run natively (wrangler `workerd`). The
manual breakdown and first-time Google-OAuth setup live in `README.md` → For
Developers and `docs/self-host.md` → Local development.

## Frontend Development (frontend/)

- SvelteKit 2 (Svelte 5, runes mode) + `@sveltejs/adapter-cloudflare`
- Tailwind CSS v4 (CSS-based config, no tailwind.config.js)
- SSR + client hydration — Svelte / Supabase's [officially recommended pattern](https://supabase.com/docs/guides/auth/server-side/sveltekit). Auth resolves server-side in `hooks.server.ts` and is serialized into the page, so first paint isn't blocked on a client-side `getSession()`.
- Auth via `@supabase/ssr`: `createServerClient` in `hooks.server.ts` + `createBrowserClient` in root `+layout.ts` (synced from server-loaded data). Both share cookie storage. `/auth/callback` is a server-side `+server.ts` that calls `exchangeCodeForSession` and 303-redirects.
- Auth gating lives in `hooks.server.ts` (route-id based: `(app)` is protected, `/login` redirects signed-in users), not in component `$effect`. Loaders and routes assume `event.locals.session` is set when their route required it.
- Public env vars via `$env/static/public`: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`, `PUBLIC_API_URL`. New code uses these, not `VITE_*` (still works but bypasses SvelteKit's typed env pipeline).

Architecture details (layers, `hooks.server.ts` shape, server-load vs client-load split, API client transport contract) live in [.claude/rules/frontend-architecture.md](.claude/rules/frontend-architecture.md).

## Local E2E Testing

Project-internal skill at [.claude/skills/local-e2e/SKILL.md](.claude/skills/local-e2e/SKILL.md) holds the prerequisite knowledge for running E2E tests against a **local** LeadAce stack (local Supabase + API/MCP Workers + frontend, real Google OAuth — same code path a self-host install runs). The harness lives in `e2e/` (see [e2e/README.md](e2e/README.md)): `smoke.sh` drives the `/leadace` onboarding chain headless, and the curl-only `regression-*.sh` scripts cover the dedup and send-and-record branches (including a real-Gmail happy path redirected to a test mailbox via `E2E_RECIPIENT_OVERRIDE`). Invoke it when the user asks to run a local E2E.

## Pre-Release Checklist (Required)

- Backend (TypeScript): `cd backend && npm run typecheck`
- Backend (tests): `cd backend && npm test`
- Frontend (Svelte): `cd frontend && npm run check`

## Branch flow & Release

Work on `develop` (default branch); merge to `main` to ship. See [.claude/rules/release.md](.claude/rules/release.md) for the release procedure and version bump rules.
