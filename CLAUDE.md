# LeadAce Plugin Development Repository

LeadAce — an autonomous sales automation Claude Code plugin by SurpassOne Inc.

## Layout

```
.claude-plugin/marketplace.json  # Marketplace definition (source: "./plugin/")
plugin/                          # Claude Code plugin (skills/, scripts/, references/, .mcp.json)
backend/                         # API Worker + MCP Worker (Cloudflare)
frontend/                        # SvelteKit web app (Cloudflare Pages)
docs/                            # Project-wide design docs, runbooks, task tracking
```

Area standards live in `.claude/rules/` and auto-load when you touch matching
files: `backend-architecture.md` (backend/), `frontend-architecture.md`
(frontend/), `plugin-development.md` (plugin/, backend/seed-content/),
`release.md` (plugin.json). Starting work in an area before touching its
files? Read its rule first.

## Commands

```bash
make dev                         # local stack: Supabase + migrate + seed + API (:8787) + MCP (:8788) + frontend (:5273)
cd backend && npm run typecheck  # required before committing backend TS
cd backend && npm test           # backend unit tests (Vitest)
cd frontend && npm run check     # required before committing frontend
```

The three check commands are the pre-release checklist. Local E2E harness:
`e2e/` (see `e2e/README.md`; prerequisites in `.claude/skills/local-e2e/SKILL.md`).

## Product Principles

- Priorities: stability, reliability, controllability, versatility. Don't
  hard-code business-specific values into skills or templates — defer them to
  project configuration (documents in the DB). Improve skills by increasing
  user control, not by enforcing behavior.
- Plans differentiate on throughput only (identities, outreach volume,
  projects); insights computed from a tenant's own data are never plan-gated.
  Quota semantics that are easy to get wrong: Free has two caps (5/day AND
  100 lifetime, whichever runs out first); paid plans use one monthly cap
  resetting at Stripe `current_period_start`; the daily window is UTC; an
  outreach action = `record_outreach` with `status: "sent"` (failures don't
  count). Enforcement: `backend/src/services/plan-limits.ts`.
- Self-host: code is open source; the same plan-limits code runs and defaults
  to Free ([docs/self-host.md](docs/self-host.md)).
- Multi-tenancy: every tenant-scoped table carries `tenant_id`, every query
  filters on it, and RLS enforces it at the DB level.
- Compliance: `gmail.readonly` is a Google Restricted scope — the CASA AL1
  assessment must be renewed annually or reply-reading breaks. Runbook:
  [docs/casa.md](docs/casa.md).

## Design Principles

- **Explore wide, output narrow**: investigate broadly; ship the minimum that
  carries the conclusion. "Just in case" filler is pure cost.
- **Keep specs simple**: default to the simplest spec that solves the problem.
  Add a conditional branch only when it encodes a real, distinct case.
- **Encapsulate spec boundaries**: narrow contracts; callers must not reason
  about internals.
- **Think before coding**: state assumptions; if multiple interpretations
  exist, present them — don't pick silently; push back when a simpler
  approach exists; ask when unclear.
- **Surgical changes**: every changed line traces to the request. Don't
  improve adjacent code or refactor what isn't broken; mention unrelated dead
  code rather than deleting it; remove orphans your change created.
- **LLM vs deterministic split**: operations with clear rules that must behave
  identically every time (DB writes, dedup, status transitions, quota) live in
  the backend behind MCP tools; context-dependent judgment and natural
  language (drafting, evaluating, strategy) stay with the LLM. A data-mutating
  endpoint applies the action *and* every consequent state update atomically,
  so the plugin calls one self-contained tool — never a fixed multi-tool
  sequence (canonical: `send_email_and_record`). MCP surface: liberal with
  read tools, conservative with write tools; a destructive tool needs a read
  counterpart (`list_drafts` → `discard_drafts`).
- **MCP tool descriptions**: terse — they ship as context on every turn. An
  MCP tool answers with a text block, never JSON: describe what the emitted
  string carries, never a JSON shape, and never name a value the string
  doesn't carry (CI: `.github/scripts/check-mcp-descriptions.mjs`).

## Coding Rules

- Language: English for code, comments, docs, and all plugin-read content.
  Non-English appears only as functional runtime data (fixed match tokens,
  user-input trigger phrases). Runtime output language is owned by
  `targetLanguage`, not this rule.
- **Types express the spec**: `any` is prohibited. Encode runtime distinctions
  in types (discriminated unions, branded types, narrowed returns) so invalid
  states cannot be constructed.
- Optionality is a design decision: add `null`/`undefined` only when absence
  is a real, distinct state; otherwise use a default or split the type into
  variants. DB columns are NOT NULL by default.
- A status/state field keeps its real-world meaning — express a feature need
  on a separate axis (derived query, extra column, new enum value), never by
  overloading an existing state.
- Prefer the boring, obvious implementation over a clever one. `const` by
  default; a `let` whose reassignment is never read is a smell.
- **Comments: default to none** — the *what* is the code itself. If code needs
  a comment to be followed, fix the structure instead. Comment only a *why*
  code cannot express: external constraint, non-obvious invariant, deliberate
  tradeoff.
- **Testing**: the type system is the first line of defense; unit tests cover
  only pure business logic types can't express (branching, arithmetic,
  ordering, parsing, dedup, thresholds). No route tests, no drizzle/DB mocks —
  DB-level behavior is covered by the `e2e/regression-*.sh` harness. Full
  standard: backend rule § Testing.

## Branch Flow & Release

Work on `develop` (default branch); merge to `main` to ship (CI deploys
Workers + Pages + plugin marketplace). Release procedure and version bump
rules: [.claude/rules/release.md](.claude/rules/release.md).
