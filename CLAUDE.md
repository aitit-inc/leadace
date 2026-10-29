# LeadAce Plugin Development Repository

LeadAce — an autonomous sales automation Claude Code plugin by SurpassOne Inc.

## Layout

```
.claude-plugin/marketplace.json  # Marketplace definition (source: "./plugin/")
plugin/                          # Claude Code plugin (skills/, scripts/, references/, .mcp.json)
backend/                         # API Worker + MCP Worker (Cloudflare)
frontend/                        # SvelteKit web app (Cloudflare Worker + static assets)
docs/                            # Project-wide design docs, runbooks, task tracking
```

Area standards live in `.claude/rules/` and auto-load when you touch matching
files: `backend-architecture.md` (backend/), `frontend-architecture.md`
(frontend/), `design-system.md` (frontend/, landing/), `plugin-development.md`
(plugin/, backend/seed-content/), `release.md` (plugin.json). Starting work in an area before touching its
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
Screens that need a particular account state — sign-in, a first chat, an
approval card, plans, account deletion, a recipient's `/q` page — are seeded
and opened, screenshotted or recorded by `cd frontend && npm run ui`, which lists the
scenarios (e2e/README.md → UI scenarios).

## Product Principles

- Priorities: stability, reliability, controllability, versatility. Don't
  hard-code business-specific values into skills or templates — defer them to
  project configuration (documents in the DB). Improve skills by increasing
  user control, not by enforcing behavior.
- Plans differentiate on throughput only (identities, outreach volume,
  projects, chat messages); insights computed from a tenant's own data are
  never plan-gated.
  Quota semantics that are easy to get wrong: the unit is a prospect, not a
  send — a prospect counts once, when its first outbound is `sent` (a
  `pre_send` reservation counts: email until resolved, form/SNS while fresh;
  failures and follow-ups don't); prospects the hosted discovery registers
  count separately against the found
  allowance at registration (`prospects.origin`); Free's window is the
  tenant lifetime, a paid plan's is the Stripe period from
  `current_period_start`; past an allowance a paid plan debits prepaid credits
  ($0.40 per contacted prospect, $0.60 per found one, `credit_ledger`) instead
  of refusing, while the balance pays for the unit in full — it never goes
  negative; auto top-up refills it right after the debit that crosses the
  threshold. Enforcement: `backend/src/services/plan-limits.ts`, debits and
  top-ups in `backend/src/services/credits.ts`.
- Billing has one main path: Stripe is the source of truth for subscriptions
  and the DB mirrors it, re-read on every event. Fix billing at that path,
  never with a special case for a symptom — a bug here costs money and the
  person's trust at once.
- Self-host: code is open source; a self-hosted install resolves every tenant
  to the unlimited tier and runs no Stripe ([docs/self-host.md](docs/self-host.md)).
- Multi-tenancy: every tenant-scoped table carries `tenant_id`, every query
  filters on it, and RLS enforces it at the DB level.
- Compliance: `gmail.readonly` is a Google Restricted scope — the CASA AL1
  assessment must be renewed annually or reply-reading breaks. Runbook:
  [docs/casa.md](docs/casa.md). Do not add `gmail.modify` or `gmail.compose`.
- Collect only published email addresses. No pattern-guessing finders
  (Hunter etc.): a guessed address is not a published one under Japan's
  anti-spam act.

## Design Principles

- **Solve at the root, on the main path**: start from what the thing is for
  and how it should work, never from the symptom. Grow or fix the mechanism the
  system already runs on instead of adding a side path around it, and prefer
  removing a wrong or redundant part to patching over it.
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
  improve adjacent code or refactor what isn't broken; remove orphans your change created.
- **LLM vs deterministic split**: operations with clear rules that must behave
  identically every time (DB writes, dedup, status transitions, quota) live in
  the backend behind MCP tools; context-dependent judgment and natural
  language (drafting, evaluating, strategy) stay with the LLM. A data-mutating
  endpoint applies the action *and* every consequent state update atomically,
  so the plugin calls one self-contained tool — never a fixed multi-tool
  sequence (canonical: `send_email_and_record`). MCP surface: liberal with
  read tools, conservative with write tools; a destructive tool needs a read
  counterpart (`list_drafts` → `discard_drafts`).
- **One API, every surface**: the Web UI, the MCP worker and the chat agent
  are clients of the same API, so what a page lets the person do, the chat
  can do through a tool; a page-only action is a gap unless only a browser can
  run it (OAuth consent, payment). A call waits for the person's approval
  card because of its effect — a send, a deletion, a rewritten strategy, a
  schedule that runs unwatched, a loosened guardrail (mailbox caps, pauses,
  who may be contacted) — never because of where the conversation is, and the
  card shows that effect itself (the emails it sends). What needs the person
  is judged once (`domain/attention`); every surface renders that list and
  none judges on its own.
- **Where a rule ends and judgment begins**: a decision is a rule only when
  its inputs settle it with nothing left to weigh. Judgment encoded as rules
  breeds endless exceptions and caps the model. Where a decision needs
  weighing, give the LLM the evidence and the authority to act. The line moves
  case by case — re-weigh it each time, above all in the learning loop
  (`domain/loop`, `services/loop`, evaluate).
- **Writing prompts** (every text an LLM reads: backend prompts, skills,
  references, tool descriptions): the goal, the target and the bar come first;
  means, rules and cautions are secondary. Hand over the goal and the current
  state, never a script of the conversation ("when X arrives, offer Y"): every
  branch a script misses is a dead end. Plain, concise, unambiguous English,
  as short as it can be. When the model does something wrong, before adding a
  "don't …" line, find the instruction behind the behavior and consider
  dropping or rewording it — subtract before you add. Plugin specifics:
  `.claude/rules/plugin-development.md`.
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
  Text that code parses is a record: give it a typed shape. A string stays
  free text only while nothing but people and LLMs read it.
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

Shipping also mirrors an allowlisted subset to the public repo
`aitit-inc/leadace` — the code trees, `.claude/`, the root docs and
`docs/self-host.md`, so what goes there is public. The rest of `docs/` and the
deploy/release workflows stay private; the allowlist in
[.github/sync/build-public-tree.sh](.github/sync/build-public-tree.sh) is the
authority.
