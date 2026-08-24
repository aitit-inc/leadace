# Workspace Conventions

Common rules for all skills and sub-agents.

## Data Storage

All project data is stored on the server and accessed via MCP tools (`mcp__plugin_leadace_api__*`). There are no local project directories or databases.

- **Structured data** (prospects, outreach logs, responses): Dedicated MCP tools (`add_prospects`, `send_email_and_record`, etc.)
- **Documents** (business info, sales strategy, search notes, cross-stage learnings): `get_document` / `save_document` MCP tools with slugs: `business`, `sales_strategy`, `search_notes`, `learnings`, plus per-strategy `playbook_<strategy-slug>` documents (see "Playbook documents" below)
- **Master documents** (templates, guidelines, frameworks): `get_master_document` MCP tool with slugs like `tpl_business`, `tpl_email_guidelines`, etc. These are shared across all users and updated centrally
- **Local files**: Only plugin SKILL.md files, local-operation references (claude-in-chrome-guide, form-filling), and scripts in `${CLAUDE_PLUGIN_ROOT}/`

## Playbook documents (user-defined discovery/outreach means)

A **playbook** is a project document (slug `playbook_<strategy-slug>`, 1:1 with a named discovery strategy) carrying everything platform-specific about a user-defined means — e.g. proposing on a crowdsourcing or matching service. Skills stay generic: resolve the playbook from the strategy slug and follow it; never hard-code a platform's procedure into a skill.

Content contract (omit sections that don't apply):

- **Prerequisites** — account, login state, browser/tool.
- **Discovery** — where/how to find candidates and the mapping to `add_prospects` (posting/listing URL → `platformUrl`; anonymous platform clients: org = the platform, client identity on the prospect).
- **Outreach** — how to compose and submit the in-platform response; the platform's rate limits / ToS constraints, stated explicitly.
- **Response check** — where replies land (in-platform inbox, notification-email sender patterns).
- **Scripts** (optional) — fenced code blocks, executed from a temp dir; never persisted as local files.

**Approval**: a playbook version saved by a skill (`save_document`) is pending until the user approves it in the Web UI → Documents (https://app.leadace.ai/documents). `get_document` serves skills only the latest approved version and says when a playbook is not usable yet — treat that exactly like a missing playbook. Versions saved from the Web UI are approved as written.

Guardrails: respect the platform's ToS and rate limits; never bypass blocks, CAPTCHAs, or bot detection — a refusal ends the attempt for that run.

## Never fabricate data

Record and persist only what you actually observed — in a tool result, on a retrieved page, in a project document. Never invent, guess, or pattern-fill a value to fill a slot: an email address, a contact name, a company fact, a metric. When the information isn't there, omit the field (or set `null` where the schema uses null for absence) — never write an empty string or a placeholder. A missing value is correct and downstream handles it; a fabricated one corrupts data (bounced sends, wrong-name greetings, false strategy signals) and is far costlier to undo than a gap. This holds no matter how capable the model is.

## Where knowledge lives (skills write procedure, not values)

LeadAce separates three kinds of knowledge. A skill describes the *procedure* and *where to look* — it never restates a default value, a server-enforced constant, or a tool-connectivity snapshot.

- **T1 — Guardrails / invariants** (supported send countries, quota, recycle windows, compliance footer, pre-send TTL): enforced **server-side** and deterministically. Skills react to the server's response (filtered candidate list, error code) — they do **not** re-encode the constant as skill logic. Example: `get_outbound_targets` already drops unsupported-country and disabled-channel prospects; the skill does not pre-filter by country.
- **T2 — Project settings** (channel on/off, target countries, outbound mode, sender info, inquiry settings): structured `project_settings` (always returns a concrete value, defaulted server-side) plus the `sales_strategy` doc for tactical preferences. Skills **read** these unconditionally — there is always a concrete value, so no `if not set then <default>` branch belongs in a skill. Stable cross-project policy (e.g. the channel ranking) lives in a master document (`tpl_channel_policy`), fetched at runtime, never copied into a skill or a generated project doc.
- **T3 — Runtime environment** (Gmail SaaS / Gmail MCP / Chrome / local fetch connectivity): **live-detected at the moment it's needed, never persisted.** No env-status document. Query `get_gmail_status` when sending; re-detect the local toolchain per run; treat Gmail MCP / Chrome as advisory and fail-safe per-prospect at the point of use.

The rule of thumb: if you're about to write a default value, a fallback (`if X is missing, assume Y`), or a hardcoded constant the server already owns, stop — surface the value from its single source instead.

## Command Execution Rules

- **Do not use cd.** Run all bash commands from the workspace root.
- Local utility tools are in `${CLAUDE_PLUGIN_ROOT}/scripts/` (e.g., `fetch_url.py`).

## MCP Tool Error Handling

If any MCP tool call returns a "Project not found" error, instruct the user to run `/leadace` first and abort the current skill.

If a correctly-used tool keeps erroring or returning unexpected results with no evident cause, suspect an outdated plugin: check `get_server_version` → `minPluginVersion`, and point the user to `/plugin update leadace@leadace` when behind.

## Document Write Safeguard

When calling `save_document` (or any MCP tool that persists user-visible document/content), sanity-check that the content matches the slug's intent and the active project context. If the content is clearly unrelated — e.g., the session has drifted to another topic, the wrong project is selected, or stray output is about to be pasted in — confirm with the user before saving. Documents are persistent and read by other skills, so a wrong write is not silently absorbed.

## Document length & content discipline

Generated project documents (`business`, `sales_strategy`, `search_notes`, `learnings`) are design / reference artifacts, not activity logs. Keep them lean:

- **Soft length targets** — a document materially past its target is carrying filler or data that belongs elsewhere; trim or relocate. `business` ~60 lines, `sales_strategy` ~180 lines, `search_notes` ~80 lines. `learnings` is bounded by entry count instead (≤15 active; evaluate retires the rest each cycle).
- **Never persist runtime actuals or per-run history into a document.** Send / draft / response counts, rates, and per-cycle logs live in structured storage (`outreach_logs`, `responses`) and are surfaced in the Web UI (`/evaluations`, `/drafts`, `/outreach`). The `sales_strategy` `## KPI` section holds *target* metrics (the reverse-calc tree) only — never an actuals / KPI-history table. A document that grows an append-only metrics table is a bug.

## Explore wide, output narrow

When investigating, weighing options, or drafting internally, cast a wide net across angles. When producing output that a skill persists or reports back (documents, settings fields, evaluation records, search-notes, completion summaries), cut to the minimum that carries the conclusion — on fresh writes and revisions alike. "Just in case" and "might as well note this" filler doesn't get read, buries the important parts, and breeds inconsistency over time — pure cost, no upside.
