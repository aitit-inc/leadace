# Backend Architecture (LeadAce API Worker)

This is the standard implementation pattern for `backend/src/`. It applies to
the API Worker; the MCP Worker (`src/mcp/`) is a thin pass-through to the API
and is governed by its own conventions.

The reference implementation is `routes/responses.ts` + `services/responses.ts`
+ `domain/{prospect-status,rejection-feedback}.ts`. When in doubt, read those
three files before adding a new endpoint.

---

## Layers

```
HTTP Adapter        api/routes/*.ts        Bind URL → service. No business logic.
   ↓
Application/Service services/*.ts          Orchestration, DB I/O, external APIs.
   ↓
Domain              domain/*.ts            Branded types, state machines, pure rules. No I/O.
   ↓
Persistence         drizzle (db/schema.ts) Single source of truth for tables.
```

No repository layer — drizzle is already a typed query builder, services
call it directly.

### `api/routes/*.ts` — HTTP adapter

Routes are the input boundary: external input is validated here via `zValidator` before reaching a service. Services receive fully typed data and never re-parse strings.

Do:

- Bind a URL + method to a service function.
- Validate every input with `zValidator('param' | 'query' | 'json', schema)` using schemas from the service / `domain/ids`; read via `c.req.valid(...)`.
- Pull `c.get('db' | 'tenantId' | 'userId')` from middleware and pass into the service.
- Map `ServiceResult<T>` to HTTP: `respondWithError(c, ...)` on error, `c.json(value, status)` on ok.

Don't:

- Call `createDb()` directly.
- Read `c.req.param/query/json()` directly — even trivial shapes go through `zValidator`. No "lenient" tier.
- Embed business rules (status transitions, quota math, multi-field validation, ...). Push to the service.
- Import what the cheat sheet forbids.

A route handler should be 5–15 lines. If it grows, push the logic down.

### `services/*.ts` — application layer

Do:

- Orchestrate the use case: load → decide → write → return. `db` is always a parameter, never pulled from Hono context.
- Own the Zod schemas for external input (path / query / body) and re-export them for the route's `zValidator`. `z.infer<typeof schema>` is the service input type — one declaration, two consumers.
- Return `ServiceResult<T>`. Throw only for programming / infrastructure errors (Hono's `app.onError` maps to 500).
- Export return-value types. Routes `c.json(result.value)`, so the service's type IS the HTTP response shape.
- Validate cross-field invariants Zod can't express alone.

Service function shape:

```ts
export async function recordResponse(
  db: Db,
  tenantId: TenantId,
  input: RecordResponseInput,  // typed, already validated by zValidator
): Promise<ServiceResult<RecordResponseResult>> { ... }
```

For endpoints with multiple input kinds, name parameters by kind: `(db, tenantId, param, query, body)` in that order, omitting any not used.

Don't:

- Read from Hono context. The route passes everything in.
- Encode HTTP status codes — errors carry a `ServiceErrorCode`; the adapter maps to HTTP.
- Re-validate typed inputs. Runtime checks that genuinely need to happen (e.g., DB lookup) go as the first step of the use case, not as input validation.
- Manually parse path / query / body strings. `zValidator` is the single parsing point.

### `domain/*.ts` — the spec, in types

Domain is where the spec lives in types: branded IDs, discriminated unions for state combinations, exhaustive transition functions. A service holding a domain value does not revalidate it — if it compiled, the invariants hold. Pure helpers (formatters, math, token construction) are allowed but secondary.

What lives here:

- **Branded primitives** for string-shaped opaque IDs (`TenantId`,
  `ProjectId`, `ShortId`). One module: `domain/ids.ts`. Construction
  goes through `<id>Schema.parse(unknown)` or `as<Id>(scalar)` at
  boundaries; internal code never accepts a raw `string` as one of
  these identifiers. Number-shaped row PKs are not branded — see
  "Branded IDs and parse-don't-validate" below for why.
- **Discriminated unions** for state combinations the schema cannot fully
  express. `InquiryCta = { mode: 'meeting' } | { mode: 'signup'; url: string }`
  replaces "two optional columns + DB CHECK". A single runtime parser
  (`parseInquiryCta`) is the only constructor; once a service holds the
  type, the url-required-when-signup invariant is enforced by the
  compiler.
- **State machines** for status / lifecycle columns. `prospect-status.ts`
  already does this for `prospects.status` (input → next-state union,
  exhaustive `switch` over the response-type enum, returning `null` when
  the response should not change status). The same shape applies to
  `outreach_logs.status`, `inquiry_sessions.outcome`, and
  `project_prospects.status`. Each module exports the state union, the
  transition function, and a typed reason when a transition is rejected.
  Services consume the result; they do not re-compute next-state inline.
- **Schema + rule co-location** — Zod schemas, sentinel constants, and
  derived predicates that share an invariant stay in one file (the
  reference is `rejection-feedback.ts`), so a rename in either surfaces
  as a compile error.
- **Pure helpers** — formatters, quota math, token construction. Take
  wall-clock / random sources as explicit arguments so domain is
  testable without mocks.

Refactor signals (move from service to domain):

- Inline `switch (row.status)` with more than two branches → state-machine
  module.
- A service-internal helper that parses an `unknown` into a typed shape →
  boundary parser, move to `domain/`.
- An optional field that two callers must check the same way before use →
  discriminated union, parse once.
- A business rule referenced in two services that must stay in sync →
  named domain function.
- An ID passed around as `string` that two services interpret differently
  → branded type, `<id>Schema.parse(...)` at the boundary.

Forbidden:

- Importing `drizzle-orm`, `db/connection`, `fetch`, crypto with side
  effects, or anything that reads the wall clock or randomness implicitly.
- Importing schema table objects (`prospects` etc.). Importing types
  (`ProspectStatus`, `RejectionFeedbackV1`) is the correct way to stay
  aligned with the DB without coupling to drizzle.
- Importing from `services/`, `routes/`, or `mcp/`. Domain is a sink. If a
  function in `domain/` wants to call a service, it is misplaced.

When NOT to add a module:

- A one-off helper used by exactly one service. Inline it; layering for
  its own sake is not value.
- A formatter with a single call site that won't grow. Keep it where it
  is used.

### `db/`

- `db/schema.ts`: single source of truth for tables, enums, JSON-column shape types, broadly-shared domain constants (e.g., `REACHABLE_STATUSES`), and Zod validators paired 1:1 with a column-narrowing type (e.g., `prioritySchema` mirrors `Priority` and the `chk_priority` DB constraint — schema, validator, DB constraint stay co-located). No table-querying helpers.
- `db/connection.ts`: the `createDb` factory. Imported only by middleware (auth, rls), services, and the few public unauthenticated routes (stripe webhook, unsubscribe) that bypass RLS deliberately.

### `auth/`

Predates the layering. `verify-jwt.ts` and `unsubscribe-token.ts` are pure token parsing — effectively domain. `google.ts` does DB I/O for Gmail credentials — service-tier in disguise. We keep the cluster together for the OAuth/JWT bundle; treat them as importable from services. New service code goes under `services/`; if `google.ts` grows, split it out as `services/gmail-*.ts`.

---

## Dependency rules (cheat sheet)

| Layer | May import | Must not import |
|---|---|---|
| `routes/` | `services/`, `services/result` (types only), `domain/ids` (identity schemas), `api/respond`, `api/zvalidator`, schema **types/enum constants only**, hono | `drizzle-orm`, `db/connection`, drizzle table objects from `db/schema`, raw zod (Zod schemas come from services or `domain/`), `@hono/zod-validator` (wrapped by `api/zvalidator`) |
| `services/` | `db/connection`, `db/schema`, `drizzle-orm`, `domain/`, `auth/`, other `services/`, zod | `routes/`, `mcp/`, `api/middleware/`, `api/respond`, `hono` (no HTTP awareness) |
| `domain/` | schema **types only**, `zod`, standard library | drizzle, `db/connection`, `services/`, `routes/`, `mcp/`, anything I/O |
| `middleware/` | `db/connection`, `db/schema`, `services/` (when needed for tenant provisioning, etc.) | `routes/` |
| `api/respond` | `hono`, `services/result` types | services/business logic |

Enforcement is by code review for now (no ESLint configured). Add a custom
import-restriction lint rule if the rules start being violated by accident.

---

## Multi-tenancy

Every data table carries a `tenant_id` column; queries always filter on it,
and RLS at the DB level is the backstop. Each user auto-gets a tenant on
first API access.

- `tenants` table: auto-created per user (1 user = 1 tenant; the
  `tenant_members` join allows many-to-1 later).
- All tenant-scoped tables have `tenant_id` and a `tenant_isolation` RLS
  policy. Global tables (`master_documents`, `org_signals_global`) have no
  RLS.
- Per-tenant unique constraints (email, form URL, project name) include
  `tenant_id` in the unique index.
- `projects.id` is an auto-generated nanoid; `name` is user-provided
  (`UNIQUE(tenant_id, name)`).
- `organizations.id` is auto-increment (not the domain). `UNIQUE(tenant_id, domain)`
  gives per-tenant dedup. The table stores domain / name / websiteUrl only.

### Roles and middleware

- `app_rls`: non-login Postgres role used by request handlers. RLS policies
  are enforced under this role. `postgres` (the superuser) bypasses RLS and
  is used only by the auth middleware and a few unauthenticated routes.
- Auth middleware resolves `userId → tenantId` via `tenant_members` on
  every request, runs as `postgres` (bypasses RLS so it can read the join
  table), and puts the resolved `tenantId` on Hono context.
- RLS middleware wraps the rest of the request in a transaction with
  `SET LOCAL ROLE app_rls` + `SELECT set_config('app.tenant_id', $1, true)`.
  Every subsequent query in that request runs as `app_rls` with the tenant
  pinned.

### What goes through `c.get('db')` vs. raw `createDb()`

- Route handlers always use `c.get('db')` — the RLS-wrapped transaction.
  This is the default and only correct path for authenticated routes.
- Raw `createDb()` is reserved for callers that have no logged-in user,
  where bypassing RLS is intentional: the auth middleware itself, the
  Stripe webhook, and the public token-authenticated routes (unsubscribe,
  inquiry landing). For those, the URL token IS the auth.

### Prospect contact-channel rule

Prospect registration requires at least one contact channel (email,
contactFormUrl, or snsAccounts). This is enforced in the service layer (a
prospect with zero channels is not a meaningful entity).

---

## Conventions

### Transactions

`rlsMiddleware` wraps each authenticated request in a transaction (it must — `SET LOCAL ROLE app_rls` only applies inside one). The `db` services receive is *already a transaction*; every drizzle write runs in the same transaction as the reads.

Do not call `db.transaction(...)` inside a service — postgres-js opens a SAVEPOINT for nested transactions, breaking outer-rollback semantics.

The two endpoints that bypass `rlsMiddleware` (`stripe-webhook`, `unsubscribe`) construct their own `db` via `createDb()` and may open transactions explicitly.

### Schemas live next to the service that consumes them

Zod schemas for a use case's input (path / query / body) live in the service file, not the route. The route imports them for `zValidator`. This keeps validation contract and service input type synced via `z.infer`:

```ts
export const recordResponseBodySchema = z.object({ ... })
export type RecordResponseBody = z.infer<typeof recordResponseBodySchema>
```

**Exception — entity-identity primitives.** Entity-identity schemas (`projectIdSchema`, `prospectIdSchema`, ...) and their param wrappers (`projectIdParamSchema = z.object({ id: projectIdSchema })`) live in `domain/ids.ts` — both the branded string-shaped ones and the unbranded aliases for number-shaped row PKs. `z.infer` co-location buys nothing for trivial primitives.

Schemas are object-shaped because `zValidator('param'/'query', ...)` requires it. Service signatures prefer scalars when trivial:

- **Single-field path** (`/:id`): route destructures, service takes the branded scalar — `(db, tenantId: TenantId, projectId: ProjectId, ...)`.
- **Multi-field path** (`/:id/:slug`): route passes the validated object — `(db, tenantId, param: DocumentParam, ...)`.
- **Body / query**: always pass the validated object — multi-field by nature.

Route shape:

```ts
router.post(
  '/projects/:id/responses',
  zValidator('param', projectIdParamSchema),
  zValidator('json', recordResponseBodySchema),
  async (c) => {
    const result = await recordResponse(
      c.get('db'),
      c.get('tenantId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return result.ok ? c.json(result.value, 201) : respondWithError(c, result)
  },
)
```

### Strict validation everywhere — no "lenient query" tier

Invalid query strings are 400, same as invalid bodies and invalid path params. No silent coercion of malformed values to a default. A bad value from a client is a client bug — surface it loudly. Use `z.coerce.number().int().min(1).max(500).default(100)` to encode "default when absent, 400 when malformed".

Routes import `zValidator` from `api/zvalidator`, not `@hono/zod-validator` directly — the wrapper normalizes failures to `{ error, detail }` so the frontend doesn't get a raw `ZodError`.

### Branded IDs and parse-don't-validate

String-shaped opaque IDs (`TenantId`, `ProjectId`, `ShortId`) travel as
branded types. The brand catches a class of mistake that runtime checks
can't — passing a project id where a tenant id was expected — at compile
time.

```ts
// domain/ids.ts — one branded primitive per string-shaped entity.
export type TenantId = string & { readonly __brand: 'TenantId' }
export type ProjectId = string & { readonly __brand: 'ProjectId' }

export const tenantIdSchema = z.string().min(1).transform((v) => v as TenantId)
export const projectIdSchema = z.string().min(1).transform((v) => v as ProjectId)

// Path / query param wrapper: same schema; the path-string wire format
// is already string-typed so no `z.coerce` is needed.
export const projectIdParamSchema = z.object({ id: projectIdSchema })

export const asTenantId = (v: string) => v as TenantId
export const asProjectId = (v: string) => v as ProjectId
```

Number-shaped row PKs (prospect / outreach_log / response / inquiry_session / evaluation / project_document / bug_report) are NOT branded — plain `number`. Compile-time payoff was small (only catches same-shape `number` arg swaps), ceremony cost was high (every DB row read needed an unverifiable `as XxxId` cast). The composite `(entity_id, tenant_id)` FKs + RLS already enforce the cross-tenant invariant at the DB level.

Input validation still uses strict positive integers: `prospectIdSchema` / `outreachLogIdSchema` in `domain/ids` are semantic aliases for the strict-`positiveInt` schema. Param wrappers (`prospectIdParamSchema`, `outreachLogIdParamSchema`, `organizationIdParamSchema`) use `z.coerce.number().int().positive()` since path/query strings are `Record<string, string>` at the wire.

Boundary handling for the string brands:

- **HTTP → service**: routes import the branded schemas, so
  `c.req.valid('param').id` is already branded and service signatures
  declare branded parameters.
- **Middleware → context**: `auth.ts` stores `TenantId` on Hono's
  context once per request; `c.get('tenantId')` is branded.
- **DB → service**: drizzle returns unbranded column types. Re-assert
  with `asTenantId(row.tenantId)` only when the value escapes the
  function as an identifier (passed to another service, embedded in a
  response). Inline use stays unbranded — branding everything is noise.
- **Service → DB**: writes need no conversion; brands are structural
  and assignable to their underlying column type.

The same parse-don't-validate shape extends to any non-trivial domain
value (`InquiryCta`, `RejectionFeedbackV1`, ...): Zod schema in
`domain/*.ts`, `.transform` produces the typed result, callers import
the schema and consume the typed output. Once parsed, the invariants
are the compiler's job.

### Service results

Services return `ServiceResult<T>`:

```ts
type ServiceResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: ServiceErrorCode; error: string; detail?: unknown; extra?: Record<string, unknown> }

type ServiceErrorCode =
  | 'INVALID_INPUT'        // 400
  | 'FORBIDDEN'            // 403 (quota/policy refusal)
  | 'NOT_FOUND'            // 404
  | 'CONFLICT'             // 409 (state-mismatch on write)
  | 'PRECONDITION_FAILED'  // 412 (e.g. Gmail not connected)
  | 'UNPROCESSABLE'        // 422 (semantically invalid: DNC, missing channel)
  | 'INTERNAL_ERROR'       // 500 (non-programming downstream failure — Stripe, etc.)
  | 'BAD_GATEWAY'          // 502 (upstream service rejected after we reached it — Gmail send rejected, etc.)
```

- Construct results with `ok(value)` and `err(code, message, detail?, extra?)` from `services/result.ts`.
- `extra` is an escape hatch for diagnostic context beyond `{error, detail}` (e.g., partial results on a pre-flight refusal). Not for common use.
- Failures flow through `respondWithError(c, result)` in `api/respond.ts` — the only place where `Context` and HTTP status mapping live. Services stay HTTP-agnostic.
- Guard-only services (e.g., `requireProject`) return `Promise<ServiceResult<undefined>>` for shape uniformity. Callers write `const guard = ...; if (!guard.ok) return guard`.

### Value builders for `db.insert(...).values({...})` payloads

Extract a pure value builder when the same row-shape construction appears in 3+ sites. Placement is governed by acyclic dependencies:

- **Single-service** helpers stay private in that service (e.g., `prospectInsertValues` in `services/prospect-import.ts`).
- **Cross-service** helpers go under `domain/<entity>.ts` (e.g., `projectProspectInsertValues` in `domain/project-prospect.ts`). Domain has zero service dependencies, so importing from there is cycle-free.

Builders take an explicit `args` object (not a Zod-inferred type) and own the column-shape concern only. `.onConflictDoNothing` / `.onConflictDoUpdate` chains stay at the call site.

---

## Testing

The type system is the first line of defense; tests are the second, and only for what types cannot express. Keep the suite **minimal and coarse-grained** — exhaustive per-endpoint coverage is a non-goal and a maintenance liability.

**Framework.** Vitest, node environment (`backend/vitest.config.ts`). Tests are **co-located** with the source as `src/**/<name>.test.ts`. Import `{ describe, it, expect }` from `vitest` explicitly (no globals). Run with `npm test`; CI runs it in the `backend` job of `.github/workflows/check.yml`.

**Test ONLY pure business logic types cannot express:**

- State machines / transitions (`nextStatusFromResponse`), arithmetic & date math (`addMonthsUtc`), ordering / tie-breaks (quota binding selection), parsing (`parseCsv`, JSON-with-fences), dedup / normalization (`resolveDedup`, `normalizeDomain`), threshold / eligibility decisions (`isAllowedSendCountry`, reapproach windows), security predicates (URL-scheme guards, token sign/verify).
- Bar: the logic must be **pure (or have a cleanly extractable pure core)**, **not guaranteed by the types**, and **carry real consequences if wrong** (mis-send, double-send, quota bypass, dedup miss, wrong status, compliance leak, billing error, token forgery). Each suite stays small: representative + boundary + a failure case or two. Don't enumerate every input.

**Do NOT test** (covered elsewhere or not worth the maintenance):

- `routes/` — thin adapters; `zValidator` + types already cover them.
- drizzle queries, service orchestration, DB I/O — no drizzle mocks (fragile, high-maintenance). DB-level behavior (quota counting, dedup against existing rows, send-and-record) is covered by the `e2e/regression-*.sh` curl harness.
- Trivial passthroughs / field mapping, and LLM-prompt string assembly (not deterministic logic).

**Extracting trapped logic.** When genuine business logic lives inside a DB-coupled service function, pull the pure decision core out so it can be tested without a DB — this is the same move as the domain "Refactor signals" above. Placement follows the dependency rules: put it in `domain/` when its types already live there (or are schema-types only); otherwise expose it as an **exported pure helper in the same service file** and test it in place (e.g. `selectOutreachQuota` in `services/plan-limits.ts`, where the `OutreachQuota` type is service-tier and may not move to `domain/`). The SQL / DB call stays in the service and feeds plain values into the pure function.
