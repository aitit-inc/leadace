---
paths:
  - "backend/**"
---

# Backend Architecture (LeadAce API Worker)

Standard for `backend/src/` (the API Worker; `src/mcp/` is a thin pass-through
to the API — response formatting only, no business logic). Reference
implementation: `routes/responses.ts` + `services/responses.ts` +
`domain/{prospect-status,rejection-feedback}.ts`. When in doubt, read those
before adding an endpoint.

## Layers

```
routes/    HTTP adapter: bind URL → service, validate input, map result to HTTP
services/  Orchestration + DB I/O + external APIs
  pipeline/  Hosted-agent stages (discover / enrich / draft / evaluate / journal / strategy-draft): LLM calls + existing services
  chat/      Hosted chat agent: thread store, system prompt, the Gemini function-calling loop
domain/    Branded types, state machines, pure rules. No I/O.
db/        drizzle schema (single source of truth). No repository layer.
tools/     The agent tool surface shared by the MCP worker and the chat agent; each tool calls the API through an injected callApi
jobs/      Cloudflare Workflow entrypoint + stage runners: puts pipeline stages into steps
```

| Layer | May import | Must not import |
|---|---|---|
| `routes/` | `services/`, `services/result` (types), `domain/ids`, `api/respond`, `api/zvalidator`, schema types/enums, hono, `tools/` (chat routes only) | `drizzle-orm`, `db/connection`, table objects, raw zod, `@hono/zod-validator` directly |
| `services/` | `db/connection`, `db/schema`, `drizzle-orm`, `domain/`, `auth/`, other services, zod | `routes/`, `mcp/`, `api/*`, `hono`, `tools/` |
| `domain/` | schema **types only**, zod, stdlib | drizzle, I/O, `services/`, `routes/`, `mcp/` |
| `middleware/` | `db/connection`, `db/schema`, `services/` | `routes/` |
| `tools/` | `domain/`, schema enums/types, zod, MCP SDK types, `mcp/version`, `services/` **types only** | `services/` runtime (tools reach the API only through `ToolCtx.callApi`), `db/`, `routes/` |
| `jobs/` | `services/`, `db/connection`, `db/rls`, `domain/`, `api/types` (types only), `cloudflare:workers` / `cloudflare:workflows` | `routes/`, `api/*` runtime, `hono` |

Hosted-agent specifics:
- A stage in `services/pipeline/` is a service: `(db, tenantId, env, projectId, …)` → `ServiceResult`. It never knows whether a Workflow step or a chat turn invoked it. Every LLM call goes through `services/gemini.ts` with a zod schema as the response constraint (`callGeminiJson` / `callGeminiUrlContextJson`); a stage that reads pages treats an empty `retrievedUrls` as "nothing was read".
- `jobs/` wraps stages in `step.do` — all side effects inside a step, step results serializable, one step per prospect where sends happen (`step.sleep` spaces them). The job path has no request transaction: a DB-only step body runs inside `tenantTx` (= `withTenantConnection`), and a pipeline stage that interleaves model calls with writes wraps each mutating service call in `runWithRls` on its own — one call, one transaction, RLS on — never the model call. `strategy-draft.ts` is request-served and must not (its caller's transaction is already open).
- `Variables.caller` is `'browser' | 'agent'`: an MCP token or the chat's in-process dispatch (marked with the per-isolate token in `api/internal-dispatch.ts`, which no outside client can present) is an agent and only ever loses privileges (approved playbooks only, UI-only settings and workspace identity refused). `Variables.origin` (`ui | mcp | chat`) is the jobs ledger's `started_by`.
- The chat's streaming routes run outside `rlsMiddleware` (the request transaction would close before the stream ends); the agent's tool calls re-enter the app via the injected dispatch and go through the normal auth + RLS stack.

Enforced by review (no lint rule yet).

- **Routes** (5–15 lines each): validate every input with
  `zValidator('param'|'query'|'json', schema)` — schemas come from the service
  or `domain/ids`, never inline zod; pull `c.get('db'|'tenantId'|'userId')`;
  map `ServiceResult` via `respondWithError(c, result)` / `c.json(value, status)`.
  No business logic, no direct `c.req.param/query/json()`.
- **Services**: shape is `(db, tenantId, param, query, body)` in that order,
  omitting unused; `db` is always a parameter. Own the Zod schemas for their
  inputs and re-export them for the route (`z.infer` = the input type; the
  exported return type = the HTTP response shape). Return `ServiceResult<T>`;
  throw only for programming/infrastructure errors. No HTTP awareness.
- **Domain** is the spec in types: branded IDs (`domain/ids.ts`),
  discriminated unions for state combinations, exhaustive state machines for
  status columns (`prospect-status.ts` is the model), schema+rule co-location
  (`rejection-feedback.ts`). Pure helpers take clock/randomness as arguments.
  Move logic here when: a `switch` on status grows past two branches, a
  parser of `unknown` lives in a service, two callers must check an optional
  field the same way, or a rule is duplicated across services. Don't add a
  module for a one-off helper with a single call site.

## Multi-tenancy and DB access

- Auth middleware resolves `userId → tenantId` (runs as `postgres`, bypasses
  RLS) and puts `tenantId` on context. RLS middleware wraps the rest of the
  request in a transaction with `SET LOCAL ROLE app_rls` + tenant pinned via
  `set_config`.
- Route handlers always use `c.get('db')` (the RLS-wrapped transaction). Raw
  `createDb()` is only for callers with no logged-in user where bypassing RLS
  is intentional: auth middleware, Stripe webhook, public token-authenticated
  routes (unsubscribe, inquiry) — there the URL token IS the auth.
- **Never call `db.transaction(...)` inside a request-served service** — the
  request is already one transaction, and postgres-js turns nested
  transactions into SAVEPOINTs, breaking outer-rollback semantics. The one
  sanctioned form is `runWithRls` (`db/rls.ts`) on a raw connection; a caller
  that outlives its request — the chat stream, the job path — takes that
  connection per call and closes it (`withTenantConnection`), never holding
  the request's across a model or tool call.
- Prospect registration requires ≥1 contact channel (email, contactFormUrl,
  or snsAccounts) — enforced in the service layer.

## Validation and IDs

- Strict everywhere — no "lenient query" tier. Malformed query strings are
  400 like bodies. "Default when absent, 400 when malformed" =
  `z.coerce.number().int().min(1).max(500).default(100)`. Routes import
  `zValidator` from `api/zvalidator` (normalizes failures to `{error, detail}`).
- String-shaped opaque IDs are branded (`TenantId`, `ProjectId`, `ShortId` in
  `domain/ids.ts`); construction goes through the id schema or `as<Id>()` at
  boundaries. Number-shaped row PKs are deliberately NOT branded (ceremony
  outweighed payoff; composite `(entity_id, tenant_id)` FKs + RLS already
  enforce cross-tenant safety) — but input validation stays strict positive-int.
- Every project-scoped endpoint accepts a project name OR id: external input
  parses to `ProjectRef`; the service's first step is
  `resolveProject(db, tenantId, ref)` which returns `ServiceResult<ProjectId>`
  and doubles as the existence guard. The brand direction (every `ProjectId`
  is a valid `ProjectRef`, never the reverse) makes "forgot to resolve" a
  compile error.
- DB reads return unbranded columns; re-assert with `as<Id>()` only when the
  value escapes the function as an identifier. Writes need no conversion.

## Service results

```ts
type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServiceErrorCode; error: string; detail?: unknown; extra?: Record<string, unknown> }
```

Codes → HTTP (mapped only in `api/respond.ts`): `INVALID_INPUT` 400,
`FORBIDDEN` 403 (quota/policy), `NOT_FOUND` 404, `CONFLICT` 409 (state
mismatch on write), `PRECONDITION_FAILED` 412 (e.g. Gmail not connected),
`UNPROCESSABLE` 422 (semantically invalid: DNC, missing channel),
`INTERNAL_ERROR` 500 (downstream failure), `BAD_GATEWAY` 502 (upstream
rejected after we reached it). Construct with `ok()` / `err()` from
`services/result.ts`. Guard-only services return
`ServiceResult<undefined>` so callers can `if (!guard.ok) return guard`.

## Value builders

Extract a pure insert-values builder at 3+ construction sites. Single-service
→ private in that service; cross-service → `domain/<entity>.ts` (domain is
cycle-free). Builders own column shape only; `.onConflict*` stays at the
call site.

## DB schema changes

`backend/src/db/schema.ts` is the single source of truth — never write
migration SQL by hand:

```bash
cd backend && npm run db:generate   # after editing schema.ts
npm run db:migrate                  # apply locally; commit schema.ts + drizzle/ together
```

- **Never edit a migration SQL file after it has been applied anywhere**
  (local, staging, or prod) — generate a new migration instead. Edited files
  drift from actual DB state and break the drizzle hash ledger; recovery is
  manual SQL surgery on prod.
- When a migration adds a tenant-scoped table, append
  `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO app_rls;` to the
  generated SQL. The `ALTER DEFAULT PRIVILEGES` from `0001_rls_policies.sql`
  only covers objects created by the role that ran it; the idempotent grant
  is the belt-and-braces.
- Production migrations run in `deploy.yml` on `main` push, over the Session
  Pooler (port 5432) — the Transaction Pooler (6543) breaks DDL like
  `CREATE ROLE`.

## TypeScript specifics

- Run `cd backend && npm run typecheck` before committing.
- Zod is v4: use top-level `z.email()` / `z.url()` / `z.uuid()`;
  `z.string().email()` is deprecated.
- Partial-update upsert endpoints (`PUT /xxx`): don't pre-load the row and
  merge — that's racy under concurrent PUTs. Set INSERT values from
  `patch ?? DEFAULTS` and `onConflictDoUpdate.set` to only the columns the
  caller provided (conditional spread). Canonical:
  `api/routes/project-settings.ts`.

## Testing

Vitest, node environment, co-located `src/**/<name>.test.ts`, explicit
imports from `vitest` (no globals). Run `npm test`.

Test ONLY pure business logic that types cannot express and where getting it
wrong has real consequences (mis-send, quota bypass, dedup miss, wrong
status, billing error, token forgery): state transitions, arithmetic/date
math, ordering/tie-breaks, parsing, dedup/normalization,
threshold/eligibility decisions, security predicates. Each suite stays small:
representative + boundary + a failure case or two.

Do NOT test: routes (zValidator + types cover them), drizzle queries, service
orchestration, DB I/O via mocks (fragile — the `e2e/regression-*.sh` curl
harness covers DB-level behavior), trivial passthroughs, LLM-prompt string
assembly.

When genuine logic is trapped in a DB-coupled service function, extract the
pure core — to `domain/` when its types live there, otherwise as an exported
pure helper in the same service file (e.g. `selectOutreachQuota` in
`services/plan-limits.ts`) — and test that. The SQL stays in the service and
feeds plain values in.

## auth/

Predates the layering: `verify-jwt.ts` / `unsubscribe-token.ts` are pure
token parsing (effectively domain); `google.ts` does DB I/O (service-tier in
disguise). Kept together for the OAuth/JWT bundle; importable from services.
New service code goes under `services/`.
