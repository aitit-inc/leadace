---
name: match-prospects
description: "Use when the user asks to \"reuse my prospects\", \"match existing leads\", \"find prospects from past projects\", or wants to pull tenant-wide prospects into a new project. Surfaces existing tenant prospects that fit the current project's targeting, then links the approved ones."
argument-hint: "<project-name> [target-count=20]"
allowed-tools:
  - Read
  - AskUserQuestion
  - mcp__plugin_leadace_leadace__list_projects
  - mcp__plugin_leadace_leadace__get_document
  - mcp__plugin_leadace_leadace__list_tenant_prospects
  - mcp__plugin_leadace_leadace__link_existing_prospects_to_project
---

# Match Prospects - Reuse Tenant Prospects

A skill that surfaces existing prospects already in the LeadAce tenant DB (collected for past projects) that fit the **current** project's targeting, and links the approved ones via `project_prospects` junction rows.

This skill never creates new prospects or organizations. To gather brand-new prospects via web search, use `/build-list`. To upload a list from a file, use `/import-prospects`.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## When to use this

- The user has run multiple projects and wants to surface overlap (a prospect collected for project A may fit project B).
- A new project's target overlaps with an older one and the user wants to skip the discovery cost.
- A `do_not_contact` flag set in another project should already protect those prospects automatically — skip the manual exclusion step.

## Inputs

- `$0` — project name (required). Must already exist; run `/leadace <your-homepage-URL>` first if not.
- `$1` — approximate target count for matched prospects (default 20). The skill stops once that many strong matches are linked.

## Steps

### 1. Resolve the project

If `$0` is provided, use it as `PROJECT_NAME`. Otherwise call `list_projects`:
- exactly one project → use it
- multiple → ask via `AskUserQuestion`
- none → abort: "No projects yet. Run `/leadace <your-homepage-URL>` first."

### 2. Load the current project's strategy

Call `get_document` with `slug: "business"` and again with `slug: "sales_strategy"`.

If either is missing, abort: "Ask `/leadace` to draft the strategy for `<PROJECT_NAME>` first — match-prospects needs SALES_STRATEGY.md to evaluate fit."

Read both. Extract:
- the target industry / segment / size / region from SALES_STRATEGY
- the value proposition and the prospect's likely pain points
- the Target's `Prerequisites` (must hold) and `Not a fit` (must not match)

### 3. Pull tenant prospects

Call `list_tenant_prospects`:

```
excludeProjectId: PROJECT_NAME   # omit prospects already linked to this project
limit: 500                       # default 200; raise if you expect a large pool
```

If the SALES_STRATEGY mentions a specific industry term, also pass `industry: "<term>"` for an exact-match filter, or `q: "<keyword>"` for a substring scan across name / overview / industry / organization name. Use the broader call (no filter) when the strategy is broad or you are unsure.

The response includes each prospect's `id`, `name`, `organizationName`, `organizationDomain`, `overview`, `industry`, `email` / `contactFormUrl` / `snsAccounts`, and `linkedProjectIds` (which other projects already pull this prospect — useful as a sanity check).

If the list is empty: report "No tenant prospects available for matching" and exit. Suggest `/build-list` or `/import-prospects` instead.

### 4. Evaluate matches

For each returned prospect, decide whether it fits the **current** project's targeting based on SALES_STRATEGY. For each match, capture:

- `matchReason` — one or two sentences explaining why this prospect fits this project's strategy. **Do not reuse the prospect's existing matchReason from another project** — write a fresh one anchored to the current SALES_STRATEGY.
- `priority` — 1 (top) to 5 (marginal), using the same rubric as `/build-list`:
  - 1: Top priority — perfectly matches target, needs are clear
  - 2: High priority — broadly matches target
  - 3: Standard — within target range
  - 4: Marginal — only partially meets criteria
  - 5: Under consideration — indirect possibility

Skip prospects that are clearly out of scope. Stop once `$1` (default 20) strong matches are collected — no need to score every prospect when the strategy is well-defined.

If a prospect has no contact channel left (no email, no `contactFormUrl`, no `snsAccounts`, no `platformUrl`), skip it — it cannot be reached via outbound. The list endpoint already excludes `do_not_contact` rows, so no manual filtering needed there.

**Note on email types:** Generic addresses (`info@`, `contact@`, `sales@`, `support@`, `pr@`) are valid outreach targets and must not be excluded as a class. Named individual addresses get slightly higher priority for reply-rate reasons, but generic-only prospects should be retained when they otherwise fit the strategy — for many companies they are the only reachable channel.

### 5. Confirm with the user

Show a compact table of the candidate matches. For each: `name` (and `organizationName` if different), `industry`, contact channels available, `priority`, and the `matchReason` you wrote. Prefer chat output over `AskUserQuestion` for the table itself — it is just for visibility.

Then ask one `AskUserQuestion`:

- **Link all** — proceed with the full set
- **Link top N** — keep the highest-priority subset (ask the user how many)
- **Drop some** — ask which ids to remove
- **Cancel** — abort without linking

If the user says "drop some", iterate once with another `AskUserQuestion` listing each candidate; do not loop more than twice.

### 6. Link the approved prospects

Call `link_existing_prospects_to_project`:

```
projectId: PROJECT_NAME
links: [
  { prospectId: <id>, matchReason: "<step 4 text>", priority: <1-5> },
  ...
]
```

Maximum 200 links per call. If the approved set exceeds 200, batch it.

The endpoint creates `project_prospects` junction rows only. It silently no-ops on duplicates (already-linked prospects are reported under `alreadyLinked`) and skips `do_not_contact` rows (reported under `skipped`).

### 7. Report

Surface what the tool returned:

- `linked` — newly linked to this project
- `alreadyLinked` — already had a junction row (no action)
- `skipped` — `do_not_contact` or not found in the tenant

If `linked > 0`, advise the user to run `/outbound` or `/daily-cycle` next. If everything was `alreadyLinked`, point out that no new junction rows were created — the user may have run `/match-prospects` already for this project.
