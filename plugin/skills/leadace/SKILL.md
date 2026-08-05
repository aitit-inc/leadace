---
name: leadace
description: "Use when `/leadace` is typed, or to set up / onboard, check the environment (Gmail / MCP), or author / refine sales strategy, targeting, or messaging. Onboards from a homepage URL, answers status questions, and routes to other skills."
argument-hint: "[free-form question, instruction, or homepage URL]"
allowed-tools:
  - Bash
  - Read
  - WebSearch
  - WebFetch
  - AskUserQuestion
  - mcp__plugin_leadace_api__get_server_version
  - mcp__plugin_leadace_api__list_projects
  - mcp__plugin_leadace_api__get_gmail_status
  - mcp__plugin_leadace_api__get_mailbox_health
  - mcp__plugin_leadace_api__setup_project
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__list_documents
  - mcp__plugin_leadace_api__save_document
  - mcp__plugin_leadace_api__get_master_document
  - mcp__plugin_leadace_api__get_project_settings
  - mcp__plugin_leadace_api__update_project_settings
  - mcp__plugin_leadace_api__get_eval_data
  - mcp__plugin_leadace_api__get_lever_state
  - mcp__plugin_leadace_api__list_suggestions
  - mcp__plugin_leadace_api__get_tenant_settings
  - mcp__plugin_leadace_api__update_tenant_settings
  - mcp__plugin_leadace_api__list_message_variants
  - mcp__plugin_leadace_api__upsert_message_variant
  - mcp__plugin_leadace_api__list_project_prospects
  - mcp__plugin_leadace_api__list_tenant_prospects
  - mcp__plugin_leadace_api__list_organizations
  - mcp__plugin_leadace_api__update_prospect
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__set_prospect_priority
  - mcp__plugin_leadace_api__set_prospect_do_not_contact
  - mcp__plugin_leadace_api__create_organization
  - mcp__plugin_leadace_api__update_organization
  - mcp__plugin_leadace_api__delete_prospects
  - mcp__plugin_leadace_api__delete_organizations
---

# LeadAce — Entry Point: Onboarding, Setup, Strategy & Routing

The single entry point for LeadAce. Behaviors:

1. **Overview mode** (no argument): version + project list + skill catalog + suggested next step.
2. **Onboarding chain** (URL argument or first-time user): run env check + strategy drafting end-to-end so the user can go from "just installed the plugin" to "ready for `/daily-cycle`" in one command.
3. **Setup / environment** ("set up", "Gmail", "MCP", "reconnect"): verify connectivity and pick or create a project — run inline (no separate skill). Environment status is live-detected each run, never stored.
4. **Strategy authoring** ("strategy", "targeting", "messaging"): author or refine `BUSINESS.md` + `SALES_STRATEGY.md` for a project — run inline (no separate skill).
5. **Free-form mode** (other text): classify intent, answer directly or route to a specific skill.

After this skill, day-to-day use needs only `/daily-cycle` (which itself fans out to `/check-responses`, `/evaluate`, `/outbound`, and `/build-list` when prospects run low). Other skills (`/build-list`, `/outbound`, `/check-responses`, `/evaluate`, `/import-prospects`, `/match-prospects`, `/setup-cron`, `/delete-project`) remain available as advanced shortcuts and as routing targets for this skill.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Gather Context (always)

Run these in parallel:

- **Plugin version**: `Read` `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/plugin.json` and take `version`.
- **Server version + min plugin**: `mcp__plugin_leadace_api__get_server_version` -> `{ serverVersion, minPluginVersion }`.
- **Project list**: `mcp__plugin_leadace_api__list_projects` (may be empty).
- **Gmail SaaS status**: `mcp__plugin_leadace_api__get_gmail_status` -> `{ connected, email? }`.
- **Current date/time**: `Bash` `date '+%Y-%m-%d %H:%M %Z'`.
- **Runtime detect** (best-effort): `Bash` `printf '%s|%s|%s\n' "${CLAUDE_PLUGIN_ROOT:-?}" "$(command -v codex 2>/dev/null || echo none)" "$([ -d "$HOME/.claude" ] && echo y || echo n)"`. Classify as `claude_code` (most common — `~/.claude` exists), `codex` (codex command found), or `other`.

If `get_server_version` or `list_projects` fails:
- Network/unreachable -> "Cannot reach the LeadAce MCP server. Check network access to https://mcp.leadace.ai (or `LEADACE_MCP_URL` for self-hosters)."
- Auth/401 -> "MCP authentication failed. Sign in again at https://app.leadace.ai, then retry."

Compare plugin version to `minPluginVersion` (split on `.`, parse each as integer, compare component-wise). If plugin version is **less than** `minPluginVersion`, prepend a prominent warning recommending `/plugin update leadace@leadace`. Continue answering — do not abort.

Hold for the rest of the skill:
- `PLUGIN_VERSION`, `SERVER_VERSION`, `MIN_PLUGIN_VERSION`
- `PROJECTS` (array)
- `GMAIL` (`{ connected, email? }`)
- `RUNTIME` (`claude_code` / `codex` / `other`)
- `NOW`

### 2. Classify Intent

Examine `$0` (the user's free-form input) together with `PROJECTS` and `GMAIL`. Pick exactly one intent label from the table below. Do not use a separate classifier — judge directly.

| Intent | Trigger condition | What to do (Step 3) |
|---|---|---|
| `onboarding` | `$0` looks like a URL (matches `https?://` or a bare domain like `example.com`), or `$0` says "start" / "始めたい" / "onboard" / "first time", or `$0` is empty AND `PROJECTS` is empty | Onboarding chain (Step 4) |
| `info_overview` | `$0` empty AND `PROJECTS` not empty; or `$0` says "overview" / "状況" / "skills" / "version" / "what can it do" | Overview mode (Step 3a) |
| `info_query` | `$0` is a question about state ("how many prospects?", "誰に送った?", "結果は?") | Inline answer (Step 3b) |
| `run_setup` | "set up", "environment", "connection", "Gmail", "MCP", "再接続", "reconnect" | Run env-check inline (Step 3e) |
| `run_strategy` | "strategy", "戦略", "target", "targeting", "messaging", "ターゲット", "refine strategy" | Run strategy authoring inline (Step 3f) |
| `add_means` | A new discovery/outreach means to add: "Upwork", "クラウドソーシング", "マッチングサイト", "この手段/プラットフォームでも営業したい", "playbook", "add ... as an outreach means" | Define a playbook-driven means inline (Step 3h) |
| `message_reset` | Replace the whole message-angle pool: "reset messaging", "メッセージを一新", "start over with new angles", "今のメッセージ全部作り直して" | Message-pool reset (Step 3i) |
| `message_steer` | A directional messaging request or a specific angle to try: "もっとカジュアルに", "make it more formal", "この角度を試して", "try an angle that leads with pricing" | Message-pool steer (Step 3i) |
| `delegate_build_list` | "list", "prospects", "more leads", "リスト追加", "もっと集めて" | Suggest `/build-list` (Step 3c) |
| `delegate_outbound` | "send", "outreach", "送信", "送って" | Suggest `/outbound` — **always confirm before** (Step 3c, with extra caution) |
| `delegate_daily` | "daily", "今日のサイクル", "run cycle" | Suggest `/daily-cycle` (Step 3c) |
| `delegate_evaluate` | "evaluate", "results", "評価", "改善" | Suggest `/evaluate` (Step 3c) |
| `delegate_import` | "CSV", "file", "ファイル", "取り込み", "import" | Suggest `/import-prospects` (Step 3c) |
| `delegate_match` | "existing prospects", "tenant assets", "プロジェクトに移動" | Suggest `/match-prospects` (Step 3c) |
| `delegate_check_feedback` | "feedback", "PMF", "feature gap", "competitor" | Suggest `/check-feedback` (Step 3c) |
| `data_maintenance` | Direct data operations outside the sales cycle: "delete prospects", "削除", "clean up the list", "整理", "fix this organization's name", "change status/priority of ...", "mark do-not-contact" | Data maintenance (Step 3g) |
| `out_of_scope` | Unrelated to LeadAce (e.g., "write me a poem") | One-line reject (Step 3d) |

Bias rules:
- URL + 0 projects -> `onboarding` (no ambiguity).
- URL + ≥1 project -> ask via `AskUserQuestion`: "Use this URL to (a) create a new project, or (b) something else?" Default to `onboarding` on (a).
- Quoted phrases like "list X" or "send to Y" -> consider the verb, not the object.
- "Messaging" is ambiguous: a request scoped to the outbound message angles / tone / subjects -> `message_reset` or `message_steer`; reworking the strategy documents (positioning, targeting, value prop) -> `run_strategy`.
- Ambiguous + projects exist -> `info_overview` (safe default).

Hold the chosen label as `INTENT`.

### 3. Branch on Intent (non-onboarding)

#### 3a. info_overview — Overview Mode

Print, in this order:

1. **Header**: `LeadAce overview - <NOW>`
2. **Version line**: `Plugin v<PLUGIN_VERSION> | Server v<SERVER_VERSION> | Required >= v<MIN_PLUGIN_VERSION>`
   - If plugin is behind, append: ` (UPGRADE: run /plugin update leadace@leadace)`
3. **Projects**: bullet list of `name (id)`. If empty: `(no projects yet — start with /leadace <your-homepage-URL>)`.
4. **Gmail status**: one line — `Gmail: connected as <email>` or `Gmail: not connected — sign in at https://app.leadace.ai`.
5. **Skill catalog** (Section 5 below, verbatim) + the self-host footer.
6. **Suggested next step**:
   - 0 projects -> "Run `/leadace <your-homepage-URL>` to set up your first project end-to-end."
   - ≥1 project, no recent activity assumed -> "Run `/daily-cycle <project-name>` for the daily run."

Then stop.

#### 3b. info_query — Inline Answer

Answer the user's question using the context already gathered (`PROJECTS`, `GMAIL`). If the question requires data not in context, call the relevant MCP tool for the most likely project (or ask which project if ambiguous):

- "結果は?" / "evaluation" / "改善案" / current results → `get_eval_data` (live metrics & response rates, also visualized in the `/evaluations` and `/dashboard` Web UI; the distilled "what worked / what didn't" memory lives in the `learnings` document)
- Project documents (business / sales_strategy / etc.) → `get_document` / `list_documents`
- Project / tenant settings → `get_project_settings` / `get_tenant_settings`
- Daily send cap / warmup / mailbox state → `get_mailbox_health` (read-only; cap changes are Web UI only)
- "提案は?" / pending AI suggestions → `list_suggestions` (acting on an add-means one = Step 3h)

Keep the answer to a few lines. Do not invoke other skills.

#### 3c. delegate_* — Skill Delegation

Tell the user the skill that fits and the args needed, e.g.:

> That sounds like `/build-list <project-name>`. Want to run it?

Wait for confirmation before suggesting they invoke it. Do **not** run another skill from inside this one — Claude Code does not support skill-from-skill invocation, and even if it did, an explicit user-typed slash command keeps the audit trail clear.

For `delegate_outbound` and `delegate_daily`, add an extra line about side effects:

> This sends real emails. Run `/outbound <project>` (or `/daily-cycle <project>`) when you're ready — it has its own pre-send confirmation.

#### 3d. out_of_scope

One polite line: "That's outside what LeadAce does. I can help with sales-automation tasks via `/leadace`, `/build-list`, `/outbound`, `/check-responses`, `/evaluate`, or `/daily-cycle`." Stop.

#### 3e. run_setup — Environment Check & Project Setup (inline)

This runs the former `/setup` flow inline. Use for first-time environment setup and for re-checking after the user reconnects Gmail / Chrome / local tools.

`Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/env_check.md` and execute its full procedure (Steps 1-4) with interactive framing. Pass:
- `$0` = the project name if the user named one, else empty
- No `$URL`

When it finishes, print a short, scannable report:
- Project in use (`PROJECT_NAME`)
- The live capability summary returned by env_check (Gmail SaaS / Gmail MCP / Chrome / local fetch)
- Any missing capabilities and what each blocks (most prominent fix-it line first — usually Gmail SaaS)
- A one-line note that recipient delivery is currently limited to the supported countries shown during the compliance step
- Next step: "Ask `/leadace` to draft your sales strategy (or run `/daily-cycle <project>` if your strategy is already set)."

#### 3f. run_strategy — Sales & Marketing Strategy (inline)

This runs the former `/strategy` flow inline: author or refine the project's `BUSINESS.md` + `SALES_STRATEGY.md`.

1. **Resolve the project** from `PROJECTS`:
   - 0 projects → "No project yet — run `/leadace <your-homepage-URL>` to set up end-to-end first." Stop.
   - exactly 1 → use it.
   - multiple → `AskUserQuestion` which project.
2. **Environment context**: status is live-detected, not stored. Pass the Gmail status from Step 1 (`GMAIL`) as the initial `ENV_SUMMARY`; strategy_drafting's interactive channel step (4-8) confirms channel availability with the user, so a full env re-check isn't required here.
3. `Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/strategy_drafting.md` and execute its full procedure (Steps 1-8) using **Mode A (Interactive Q&A)**. Pass `$0` = the resolved project name, no `$URL`. Mode A auto-detects initial vs update sub-mode (Step 3) and offers a URL fast-path (Step 4-0).
4. Report per strategy_drafting Step 8: initial → overview of the 2 generated docs + `inquiry_chat_brief` status, guide to `/build-list` or `/daily-cycle`; update → summary of updated / added sections.

#### 3g. data_maintenance — Direct Data Operations

Home for prospect / organization CRUD that the sales-cycle skills never perform: field
fixes (`update_prospect`, `update_organization`), status / priority / DNC overrides
(`update_prospect_status`, `set_prospect_priority`, `set_prospect_do_not_contact`), and
permanent deletion (`delete_prospects`, `delete_organizations`).

**Mandatory flow for destructive or bulk operations** (deletion always; any edit
touching more than a handful of records):

1. **Preview with the read counterpart** — `list_project_prospects` /
   `list_tenant_prospects` / `list_organizations` — and build the exact target set.
2. **Present the plan to the user before executing**: what will be changed or deleted
   (counts, a few representative examples), why, and that deletion is permanent.
3. **Execute only after explicit approval.** No approval, no call.
4. **Report the outcome faithfully**, including server-side skips with their reasons —
   the server refuses those rows by design; do not retry around them. After
   `delete_prospects`, offer the reported prospect-less organizations to
   `delete_organizations`.

Single-record, clearly-stated edits ("fix this org's name to X") may run directly —
still report what changed. Never fall back to raw SQL; these tools are the supported
surface.

#### 3h. add_means — Define a Playbook-Driven Means

For a means the built-in channels don't cover — e.g. proposing on a crowdsourcing or
matching service. `Read` `references/workspace-conventions.md` → "Playbook documents"
first. Outcome: a named discovery strategy + its playbook saved and the `platform`
channel enabled — the cycle skills pick the means up with no further wiring.

1. **Resolve the project** (same as 3f step 1).
2. **Interview** for the playbook contract: platform + URL, what a good posting looks
   like, account/login state, how proposals are submitted, rate limits / ToS, where
   replies land. Given a platform URL, offer to research it (`fetch_url.py` /
   WebSearch) and draft for review instead of asking everything.
3. **Write both artifacts** (show to the user before saving): the `### <slug>` entry
   in `## Prospect Discovery Sources` of `sales_strategy` (Status: active, How
   references the playbook), and the `playbook_<slug>` document. If an open
   `add-means` suggestion matches (`list_suggestions`), reuse its `dedupeKey`
   as `<slug>` so the saved playbook auto-closes it.
4. **Enable the channel**: `update_project_settings` — add `"platform"` to
   `outboundChannels`, preserving existing entries.
5. **Report**: slug, playbook saved, channel enabled; `/evaluate` promotes/demotes it
   like any strategy; point to `/build-list` or `/daily-cycle`.

#### 3i. message_reset / message_steer — Message-Angle Pool Operations

The message-angle pool (`message_variants`) is the measured experiment surface
`/outbound` draws from; the daily lever tick shifts weight toward what gets
replies. These intents change *what is being tested* — they never pick winners
(the tick does) and never rewrite an existing arm's copy (that corrupts its
measured history; new content = new arm on a fresh slug, never a reused one).

1. **Resolve the project** (same as 3f step 1), then read the current pool for
   context: `list_message_variants` + `get_lever_state` (which angles lead, their
   maturity).
2. **Branch on the intent**:
   - **Reset** (replace everything): briefly interview for the new direction —
     what felt wrong about the current set, desired tone / positioning emphasis.
     Then follow the pivot mechanics of
     `${CLAUDE_PLUGIN_ROOT}/references/onboarding/strategy_drafting.md` Step 7.6:
     archive every active variant first (echo each `subjectPattern` unchanged,
     `archived: true`), then seed 4 boldly different angles per that step's
     generation rules on fresh slugs (e.g. `rst_20260715_a`). Present the plan
     (what gets archived, the 4 new angles) and get explicit approval before the
     first write.
   - **Steer** (add a direction): craft 1-2 new angles embodying the requested
     direction (Step 7.6 generation rules apply: real angle, not a micro-copy
     tweak) and upsert them on fresh slugs — they compete with the existing arms
     on equal footing and the tick decides. If the server refuses on the active
     cap (400), show the active arms and ask which to archive; never archive
     silently.
3. **Report**: the active pool after the change, and that the tick shifts weight
   as replies mature (a reset restarts measurement — the first read is ~2 weeks
   out).

### 4. Onboarding Chain (intent = onboarding)

Goal: from "user just typed `/leadace https://example.com`" to "project + business + sales_strategy saved, ready for `/daily-cycle`" — asking the user exactly once, at the review in 4.2. A URL is the go-ahead, so there is no Y/N gate, and anything the chain can read, detect or default is never a question.

**Initial-state-or-not handling**:
- 0 projects -> proceed straight into the chain.
- ≥1 project + URL provided -> per Step 2 bias rules, the user has chosen "create a new project" (or has been asked).
- ≥1 project + no URL + user said "start" -> ask for the URL via `AskUserQuestion` ("Paste your homepage URL — we'll use it to draft the strategy.").
- 0 projects + no URL -> ask for the URL.

Hold the URL as `URL`. Say in one line what is about to happen, then start.

#### 4.1 Run env_check

`Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/env_check.md` and execute its full procedure (Steps 1-4). Pass:
- `$0` = empty (the chain derives the project name from the URL in env_check Step 3-2)
- `$URL` = `URL` (the homepage URL the user provided)

Passing `$URL` is what makes the reference run without prompting. After this you have `PROJECT_NAME` and the capability summary.

#### 4.2 Run strategy_drafting (Mode B)

`Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/strategy_drafting.md` and execute its full procedure (Steps 1-8) using **Mode B (URL-driven inference)**. Pass:
- `$0` = `PROJECT_NAME`
- `$URL` = `URL`

Mode B infers the strategy from the page, defaults everything else, and puts the whole proposal in front of the user as §4B-3's single review round before §4B-4 saves it.

#### 4.3 Completion Summary

Print:

1. **Header**: `Setup complete - <PROJECT_NAME>`
2. **What was created**: project, `business` doc, `sales_strategy` doc, sender info + outbound channels in project settings, initial `inquiry_chat_brief`, message-angle variants.
3. **Anything that still blocks sending** — Gmail not connected (fix: https://app.leadace.ai) or a workspace-identity field left blank in the review (fix: https://app.leadace.ai/workspace-settings). Both refuse `/outbound` and `/daily-cycle` until set. Omit the whole item when nothing is blocked.
4. **Capability summary** from env_check, plus one line that Gmail-MCP / browser-automation were assumed `unsure` and can be re-checked by asking `/leadace`.
5. **Recipient delivery scope**: one line that delivery is limited to the currently supported recipient countries, so the operator's targeting matches the send-time guardrail.
6. **Defaults you can change later**: outbound mode is `draft` so nothing sends without your review; the AI inquiry chat is live on the recipient landing page (the inquiry landing defaults to enabled — toggle it off in the Web UI if you don't want recipient links to surface); landing extras (video / PDF / brand color / logo / CTA) are on the Web UI Inquiry page — or ask `/leadace` to refine the strategy / messaging.
7. **Next steps**:
   - `/daily-cycle <project>` — runs initial prospect collection (`/build-list` is auto-triggered when the list is empty), drafts outreach, and shows you the queue.
   - `/setup-cron <project>` (optional) — schedule the daily cycle to run on its own.
8. **Memory snippet** (Section 4.4) — optional, for the user to paste if they want it.

#### 4.4 Runtime Memory Snippet

Print a short snippet the user can paste into their runtime's persistent memory so future sessions know LeadAce is set up. Show the snippet for the detected `RUNTIME` only:

- `claude_code`:

  ```
  Append this to ~/.claude/CLAUDE.md (or your project's CLAUDE.md):

  ## LeadAce
  Sales automation plugin. Default project: <PROJECT_NAME>.
  Daily flow: /daily-cycle <PROJECT_NAME>.
  Entry point (setup, strategy, overview, onboarding): /leadace. Advanced: /build-list, /outbound, /check-responses, /evaluate, /import-prospects, /match-prospects, /setup-cron, /delete-project.
  Outbound is irreversible — always confirm before /outbound or /daily-cycle.
  ```

- `codex`:

  ```
  Add to ~/.codex/AGENTS.md (or equivalent):
  [same text as above]
  ```

- `other`:

  ```
  Save this to your runtime's memory / custom instructions:
  [same text as above]
  ```

Do not write the file automatically in this version — present it for the user to paste. (Auto-write is deferred to a later release once we've confirmed the safe path per runtime.)

### 5. Skill Catalog (used in overview mode, referenced in delegation)

Three tiers — daily use only needs the first two. Print under sub-headings so users see the entry points first.

**Daily** — these are all you need once set up.

| Skill | One-line purpose |
|---|---|
| `/leadace` | This skill — entry point: onboarding, environment setup / re-check, strategy authoring, message-angle reset / steer, overview, and routing. |
| `/daily-cycle` | The daily run: `check-responses` -> `evaluate` -> `outbound`, plus auto-`build-list` when prospects run low. |

**Advanced** — direct access to the steps `/daily-cycle` runs, plus list-management entry points. (Environment setup / re-check and strategy authoring are handled by `/leadace` itself — ask it in plain language.)

| Skill | One-line purpose |
|---|---|
| `/build-list` | Web-search-driven prospect collection based on the project's strategy; registers candidates in the DB. |
| `/outbound` | Execute outreach (email / contact form / SNS DM) against the project's prospect list. |
| `/check-responses` | Detect replies and scheduling notifications, record them as `responses`. |
| `/evaluate` | Analyze response-rate data; report findings and apply targeting / keyword / discovery-portfolio updates (message angles, channel & selection order are auto-optimized by the lever tick). |
| `/import-prospects` | Load prospects from a file (CSV / Excel / SQLite / text) — either as tenant assets or linked to a project. |
| `/match-prospects` | Pull existing tenant-wide prospects into a project that fits the targeting. |
| `/check-feedback` | PMF-oriented review of rejection feedback (Pro-tier introspection). |
| `/setup-cron` | Install an OS-level schedule (LaunchAgent / Task Scheduler / cron) that runs `/daily-cycle` daily. |

**Maintenance**

| Skill | One-line purpose |
|---|---|
| `/delete-project` | Permanently delete a project and its data from the server. |

**Footer (always print after the catalog in overview mode):** `LeadAce is open source — host it yourself on Cloudflare + Supabase: https://github.com/aitit-inc/leadace/blob/main/docs/self-host.md`

Keep this catalog up to date when adding or removing skills.
