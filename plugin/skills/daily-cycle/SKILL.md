---
name: daily-cycle
description: "This skill should be used when the user asks to \"run the daily cycle\", \"run today's sales\", \"do the daily sales tasks\", \"run daily-cycle\", or wants to run the daily sales automation cycle. Automatically runs check-responses -> evaluate -> outbound + build-list (when needed) in sequence."
argument-hint: "<project-id> [outbound-count=30]"
allowed-tools:
  - Bash
  - Read
  - Agent
  - mcp__plugin_leadace_api__list_projects
  - mcp__plugin_leadace_api__get_outbound_targets
  - mcp__plugin_leadace_api__add_prospects
  - mcp__plugin_leadace_api__check_prospect_dedup
  - mcp__plugin_leadace_api__get_recent_outreach
  - mcp__plugin_leadace_api__send_email
  - mcp__plugin_leadace_api__send_email_and_record
  - mcp__plugin_leadace_api__record_outreach
  - mcp__plugin_leadace_api__skip_prospect
  - mcp__plugin_leadace_api__record_response
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__get_eval_data
  - mcp__plugin_leadace_api__run_lever_tick
  - mcp__plugin_leadace_api__get_lever_state
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__save_document
  - mcp__plugin_leadace_api__get_master_document
  - mcp__plugin_leadace_api__get_project_settings
  - mcp__plugin_leadace_api__get_compliance_status
---

# Daily Cycle - Daily Sales Cycle Execution

A skill that automatically runs a full day of sales activities. All phases are executed by sub-agents to keep the main context lightweight.

**Important: Do not use `context: fork` in this skill.** Due to the one-level nesting limit for sub-agents, daily-cycle itself must run in the main context and launch each phase via the Agent tool.

**Context Lightweight Rules:**
- Sub-agents return **only a minimal summary (3 lines or fewer) needed for decisions** to the main context. Detailed data is stored in the DB via MCP tools (record_outreach, record_response, etc.)

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Arguments

- Project ID: `$0` (required)
- Outbound count: `$1` (default: 30)

## Steps

### 1. Setup

First, get the exact current date, time, and day of week. Treat this result as authoritative for subsequent steps (takes priority over system date information).

```bash
date '+%Y-%m-%d %H:%M (%A)'
```

Verify that the project is registered on the server:

Call `mcp__plugin_leadace_api__list_projects` and check that `$0` appears in the list. If not found, **abort** with a message to run `/leadace` first.

**Compliance pre-flight.** Call `mcp__plugin_leadace_api__get_compliance_status`. If `ready: false`, **abort the cycle** before starting any phase — every send path will fail with HTTP 412 until the missing fields are filled, and there is no point running build-list / evaluate / outbound. Tell the user which fields are missing (from `missing`) and direct them to `fix_url`. Re-run `/daily-cycle` once the workspace fields are saved.

### 2. Review Previous Cycle

Use DB queries to understand the state from the previous cycle:

- Call `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1` to get the current reachable count

Use this information to inform subsequent steps when relevant. For example:
- If reachable count is very low -> Run build-list earlier

(The evaluate sub-agent reads the `learnings` document directly, and outbound reads it by stage tag, so the prior cycle's analysis re-enters downstream stages automatically — no need to pre-load it here.)

### 3. Start Notification Email

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"` to get the notification recipient email from the "Notification Settings" section. Skip if notification is "none" or not set. (The sender is the user's connected Gmail address — no manual sender lookup needed.)

Compose the email body concisely using only information already on hand -- no additional queries:
- Execution date and time (result from step 1)
- Project name (`$0`)
- Outbound target count (`$1`)
- Results from previous cycle (1-2 lines extracted from DAILY_CYCLE_REPORT.md in step 2; omit for first run)

Call `mcp__plugin_leadace_api__send_email` with the notification recipient as `to`, subject `"daily-cycle started: $0"`, and the body. (Use `send_email`, not `send_email_and_record` — this notification is not prospect outreach and should not be logged.)

If sending fails (e.g. Gmail not connected), continue the cycle (errors will be reported in the wrap-up report).

### 4. check-responses (sub-agent)

Launch a sub-agent using the Agent tool to check for replies.

Include the following in the prompt:
- Project ID: `$0`
- Read `${CLAUDE_PLUGIN_ROOT}/skills/check-responses/SKILL.md` and follow its procedure
- Return to main with **only a 3-line summary**. Example: "3 responses (positive 2, neutral 1). 2 drafts created. 0 do-not-contacts."

After receiving the summary from the sub-agent, report it to the user.

### 5. evaluate (sub-agent, conditional)

Run every cycle.

Include the following in the prompt:
- Project ID: `$0`
- Read `${CLAUDE_PLUGIN_ROOT}/skills/evaluate/SKILL.md` and follow its procedure
- Return to main with **only a 3-line summary**. Example: "Response rate 4.2%. 2 search keywords added, 1 discovery strategy demoted. Levers: angle v2 leading, email affinity in software_tech."

After receiving the summary from the sub-agent, report it to the user.

### 5b. run_lever_tick (outbound optimization)

Run every cycle, right after evaluate. Call `mcp__plugin_leadace_api__run_lever_tick` once with `projectId: "$0"` — a single deterministic backend call, no sub-agent. From mature reply data it recomputes (1) the server-side message-variant draw weights (Thompson sampling; archives a variant whose P(best) stays below the threshold at maturity, and after a sustained flat streak where every mature angle is statistically indistinguishable, rotates out the weakest — marked `reason: "stagnation"` — so the next cycle's evaluate supplies a fresh angle), (2) the discovery-strategy draw weights over the active registry (same Thompson math; archives dominated strategies, never below two active — the next cycle's evaluate registers fresh ones when the pool falls below target), (3) the per-industry channel affinity that `get_outbound_targets` surfaces, and (4) the targeting lifts behind the `get_outbound_targets` ordering, and (5) the futility vitals — whether recent mature email sends are statistically drawing any replies at all. All leave low-volume projects on their current behavior until enough data accrues. Idempotent per UTC day, so re-running the cycle is safe.

Report the one-line result to the user (whether it ran or was already done today, sample progress, any archived variants, channel affinity buckets, and the vitals verdict). A FUTILE vitals verdict must also reach the step 9 wrap-up report: it means outreach is drawing no replies and the user should check deliverability and targeting before the loop keeps sending.

### 6. Check List Remaining and Determine Execution Order

Check the number of reachable prospects (status = 'new' plus 'deferred' prospects whose recontact window has passed):

Call `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1`.

Read the `total` and `byChannel` fields from the response:
- `total`: total reachable count
- `byChannel.email`: prospects with email
- `byChannel.formOnly`: prospects with form only (no email)
- `byChannel.snsOnly`: prospects with SNS only (no email or form)
- `byChannel.platformOnly`: prospects reachable only in-platform (playbook means)

**Email depletion check:** If `byChannel.email` = 0 and `byChannel.formOnly` + `byChannel.platformOnly` < 5, outbound effectiveness will be very low. In this case, skip outbound and **run step 8 (build-list) first** to replenish email holders. After replenishment, re-run step 6; if email > 0, proceed to outbound. If email = 0 even after build-list, run outbound for the number of formOnly/platformOnly prospects (report the email depletion state to the user).

**Execution order determination:** If `total` is less than **1/3 of the specified outbound count**, run step 8 (build-list) first to replenish the list, then return to step 7 outbound.

- email = 0 and formOnly + platformOnly < 5 -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)
- total >= 1/3 of specified count -> step 7 (outbound) -> step 8 (build-list, if needed)
- total < 1/3 of specified count -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)
- total = 0 and build-list not yet run -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)

### 7. outbound (sub-agents x batch split)

**Determine actual outbound count:** Use `min(specified count, total from step 6)` as the actual outbound count. If total is 0 (including after step 8), skip outbound and proceed to step 9.

**Browser-driven submission limit:** Cap form submissions and platform responses at **5 per cycle combined**. Browser-driven sends consume 10-20 tool calls each and are the primary cause of context exhaustion. If `formOnly` + `platformOnly` from the step 6 channel breakdown exceeds 5, carry the excess over to the next cycle. No limit for prospects with email.

Split the outbound count into **batches of 10** and launch each as a **separate sub-agent in series**.

Example: 30 prospects -> 3 sub-agent launches (10 each)

Include the following in each sub-agent's prompt:

```
You are an outbound sales agent. Please reach out to each company on the prospect list via email, form, SNS DM, or in-platform response (per its channel).

## Preparation (read in this order)

1. First retrieve strategy documents via MCP:
   - Call mcp__plugin_leadace_api__get_document with projectId "$0" and slug "business"
   - Call mcp__plugin_leadace_api__get_document with projectId "$0" and slug "sales_strategy"
   Understand:
   - SALES_STRATEGY "Sales Channels" section: tactical preferences only (ordering, tone, sub-channel preferences). Channel enablement is owned by `outboundChannels` in project settings (applied in outbound/SKILL.md step 1).
   - Email messaging hints (First Outreach approach: what to emphasize, what never to claim). There is no stored body template — each body is written per recipient in the outbound step (outbound/SKILL.md)
   - Sender information: signature block only (the `From:` address and display name are applied server-side by `send_email_and_record` from the project's sending mailbox + project settings)
   - SNS messaging policy

2. Next, read `${CLAUDE_PLUGIN_ROOT}/skills/outbound/SKILL.md` and follow its procedure

3. Also read these based on the channel:
   - For email: retrieve via mcp__plugin_leadace_api__get_master_document with slug "tpl_email_guidelines"
   - For forms: read `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/form-filling.md` and `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/claude-in-chrome-guide.md`

## Required Rules for Sales Policy

- **Message angles:** Message angles (subject pattern + optional body approach) live server-side in `message_variants`. Per send, call `mcp__plugin_leadace_api__pick_message_variant` to draw one (the server picks by weighted draw) and forward `variantId` to `send_email_and_record` so `outreach_logs.variant_id` is stamped. If no active variants are registered, generate a one-off subject and send without `variantId`. Do not use the same subject for every prospect.
- **Email opening:** Reference specific characteristics, industry, or initiatives of the target company. Generic greetings like "I visited your website" alone are not acceptable
- **Full body:** Weave prospect-specific information from overview and matchReason throughout multiple parts of the email -- write in context tailored to the recipient, not template replacement. The compliance footer (legal name, address, unsubscribe) is appended server-side; do **not** include any of those in the body.

## Task

- Project ID: $0
- Batch number: N
- Count: 10 (final batch may be fewer)
- Retrieve prospects via mcp__plugin_leadace_api__get_outbound_targets with projectId "$0" and limit 10
- For each prospect, follow `${CLAUDE_PLUGIN_ROOT}/skills/outbound/SKILL.md`'s channel-pick + send sequence. The skill picks one MCP per channel (`send_email_and_record` for email, `record_outreach_with_inquiry` for form/SNS/platform), uses `skip_prospect` for deliberate skips (bad timing / no fresh material), and `update_outreach_status` to resolve form/SNS/platform rows — do **not** add an extra log call after a successful send (that path bypasses the compliance footer and would double-log). Recipient-country eligibility is filtered server-side by `get_outbound_targets`; there is no skill-side country pre-flight.
- Return to main with **only: success count, failure count, inactive count, main failure reasons (if any), list of variantIds used**
  Example: "Success 8, Failure 1 (form submission error), Unreachable 1. Variants: v1 x 4, v2 x 3, v3 x 3"
```

**Reason for series execution:** Each batch queries prospects from the server sequentially, so parallel execution risks duplicate outreach.

**Sub-agent refusal fallback:** If a sub-agent refuses browser operations (form submissions, etc.) and can't proceed, re-run that batch in the main context. When re-running in main, process only form targets and check with `get_outbound_targets` to avoid duplicating email-sent prospects.

Report progress after each batch summary (e.g., "outbound: 10/30 completed").

**Success rate check between batches:** After each batch completes, check the success rate (successes / processed). If rate is below 30%, stop remaining batches and autonomously decide and execute the following:
- Failure reason is insufficient contacts (many inactive) -> prioritize step 8 build-list and replenish prospects with contact info
- Failure reason is a system issue (Gmail token revocation / quota exhaustion / API errors) -> abort all outbound and report the issue in the completion report
- Failure reason is form incompatibility, etc. -> continue remaining batches with only email-available prospects

**Retry when target not met:** After all outbound batches complete, tally each batch's results. If total successes < specified count:

1. Re-check reachable remaining via `mcp__plugin_leadace_api__get_outbound_targets` with `limit: 1` (read `total`)
2. If total > 0, run the shortfall (specified count - total successes) as an additional batch (same prompt format)
3. Retry **one round only**
4. If total is 0, skip retry and proceed to step 8

### 8. build-list (only when needed, 3-step structure)

Run in any of the following cases:
- Step 6 determined to run build-list before outbound
- Remaining list (step 6 total - consumed in step 7) is less than 3x the outbound count
- Batch success rate check in step 7 determined that contact replenishment is needed

Set the target count the same as the outbound count (`$1`, default 30). Aim to meet the target in terms of **reachable count**, not registration count (collect more candidates to account for those without contact info).

Since the build-list skill internally launches sub-agents, it cannot be called directly from daily-cycle (nesting constraint). Instead, run each phase of build-list as individual sub-agents:

**8a. Candidate collection (sub-agent)**

May be **launched in parallel** with the last outbound batch in step 7 (candidate collection only adds new entries so there's no duplicate risk).

Include the following in the prompt:
- Project ID: `$0`
- Target count
- Read Phase 1 (steps 1-5) of `${CLAUDE_PLUGIN_ROOT}/skills/build-list/SKILL.md` and follow its procedure
- **Contact retrieval (email, form, etc.) is not needed**. Collect candidate name, official URL, overview, industry, country, match reason, and priority
- After completion, return the candidate list as a JSON array (each object: name, organization_name, website_url, overview, industry, country, match_reason, priority (numeric 1-5 per build-list SKILL.md definition), discovery_strategy (slug of the named strategy that surfaced the candidate, per build-list step 3)), plus a `planCompliance` summary: per-strategy planned vs collected counts (build-list step 3's `batchPlan`) with shortfall reasons
- Also update search notes via `mcp__plugin_leadace_api__save_document` with `projectId: "$0"`, `slug: "search_notes"`

**8a2. Pre-dedup filter (main context)**

Call `mcp__plugin_leadace_api__check_prospect_dedup` with `projectId: "$0"`
and `candidates: [{organizationDomain, email?, contactFormUrl?}, ...]` —
one entry per 8a candidate (`organizationDomain` is the apex domain
extracted from `website_url`, strip `www.` and path). Drop any candidate
whose `kind === 'skip'` from the list before launching 8b. This avoids
spending sub-agent / WebFetch / LLM cycles on candidates that 8c would
reject. 8c (`add_prospects`) re-runs the same dedup as a safety net, so a
few skip-marked passing through is harmless — the goal is to skip the
heavy 8b work.

If the dedup-skip ratio (kind === 'skip') in this step is ≥ 70% of 8a
output, the current search angle is exhausted; the build-list-style pivot
(different keyword / region / size cell) should be considered for the next
cycle. (Phase 8a2 only emits dedup reasons — `plan_limit` would only show
up at 8c and is a budget signal, not an exhaustion signal; if the user is
near a plan cap, do not interpret it as keyword fatigue.)

**8b. Contact retrieval (sub-agents x batches)**

Split the **post-8a2 candidate list** (only `kind === 'fresh'` entries)
into **batches of 10** and launch a sub-agent for each.

Include the following in each sub-agent's prompt:
- List of assigned candidates (pass the relevant portion from 8a output)
- The active strategies' `approach` text — read `discovery.strategies` (entries with `archivedAt: null`) from `mcp__plugin_leadace_api__get_lever_state` with `projectId: "$0"` once in the main context and pass it along; the enrichment procedure's external-search step draws its platform / directory list from it
- Retrieve the contact enrichment procedure via `mcp__plugin_leadace_api__get_master_document` with `slug: "tpl_enrich_contacts"` and follow its procedure
- Explore each candidate's official site to retrieve email addresses, contact form URLs, and SNS accounts
- After completion, return results as a JSON array

**8b2. Re-search for candidates without contacts (sub-agent, only when applicable)**

If 8b results show candidates with both email / contact_form_url as null, launch a sub-agent to try supplementing from non-official sources.

Include the following in the prompt:
- List of target candidates (name, website_url). Up to 10
- For each candidate, search WebSearch for `"{company name}" email address`, `"{company name}" contact`, etc., to find contacts from industry directories or press release sites
- Return found contacts (email, contact_form_url, sns_accounts) as a JSON array
- Candidates not found do not need to be included in results

Merge sub-agent results into the 8b result data.

**8c. DB registration (main context)**

Combine Phase 1 candidate info and Phase 2 contact info into complete prospect objects, then call `mcp__plugin_leadace_api__add_prospects` with `projectId: "$0"`.

For each prospect, construct the MCP tool fields:
- `organizationDomain`: apex domain extracted from `website_url` (strip `www.` and path)
- `organizationName`: organization/entity name (or `name` if same)
- `organizationWebsiteUrl`: official site URL
- Plus all other fields: `name`, `overview`, `websiteUrl`, `email`, `contactFormUrl`, `formType`, `snsAccounts`, `matchReason`, `priority`, `discoveryStrategy` (from 8a's `discovery_strategy`), etc.
- **At least one of `email`, `contactFormUrl`, `snsAccounts` must be set** (prospects without contact channel are rejected)

The server returns `skippedDetails` with `{name, reason}` for rows it rejected (`already_in_project` / `email_duplicate` / `form_url_duplicate` / `do_not_contact` / `duplicate_in_batch` / `unknown_industry` / `unknown_strategy`). Surface the breakdown in the completion report so the user can see how much of the candidate pool was already covered.

**8d. Reachable recheck and summary output**

After build-list completes, re-check reachable count via `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1`.

Report build-list summary (added count, reachable count, and per-strategy plan
compliance — 8a's `planCompliance` reconciled against 8c's registration
results, shortfalls noted with reason) to the user.

If step 6 determined to run build-list first, proceed to step 7 (outbound) from here.

### 9. wrap-up (sub-agent)

**After all phases complete, send the completion notification in a sub-agent.**

Include the following in the prompt:
- Project ID: `$0`
- Execution date and time: the datetime obtained in step 1
- Phase summaries collected from sub-agents during this cycle (check-responses, evaluate, outbound, build-list)
- The lever / trajectory narration from evaluate and step 5b (current response rate, which message angle / channel affinity is leading, sample progress, any angles added or archived this cycle with reason and numbers, any revisit-strategy suggestion raised, and the vitals verdict when step 5b reported FUTILE)
- Any autonomous execution-order decisions taken this cycle and why (email depletion → ran build-list first; outbound success rate < 30% → aborted; form submissions capped at 5 → N carried to next cycle; total reachable 0 → outbound skipped). "None" if the cycle ran straight through.

**Completion Notification Email**

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"` and read the notification recipient email from its "Notification Settings" section. Skip if notification is "none" or not set. `send_email` sends from the connected Gmail account and takes no sender arguments.

Compose the report body from the phase summaries passed in the prompt:

```
Daily Cycle Report — YYYY-MM-DD HH:MM
Project: $0

check-responses: (summary)
evaluate: (summary)
outbound: (summary)
build-list: (summary)

Lever changes: (this cycle's angle line-up changes, or "none")
Trajectory: (response rate now and its direction vs the last cycle if known / what the levers are currently optimizing / the one focus for next cycle — say "still accumulating data" when it is too early to claim a trend; never imply progress the numbers do not show)
Decisions: (the autonomous execution-order calls this cycle and their reason, or "none")
```

`Lever changes:` mirrors the dashboard's decision journal — use its wording so the email and the dashboard tell one story: a new angle → `Started testing a new angle “X”`; a stagnation rotation → `Swapped out “X” — results stayed flat`; a variant retired because a stronger one won → `Retired “X” — a stronger angle won`; a revisit-strategy suggestion → `Flagged for your review: <title>`. Use the variant's label when known (variantId otherwise) and append `(win chance NN% · N sends)` when the tick reported those numbers. Routine reweighting with no line-up change is "none" — a line appears only on state change, same as the journal.

Call `mcp__plugin_leadace_api__send_email` with the notification recipient as `to`, subject `"daily-cycle completed: $0"`, and the report body. (Use `send_email`, not `send_email_and_record` — this is an internal report, not prospect outreach.)

Per-cycle actuals are **not** written to any document. Send / draft / response counts live in structured storage (`outreach_logs`, `responses`) and are surfaced in the Web UI (`/evaluations`, `/drafts`, `/outreach`); the distilled analysis memory lives in the `learnings` document. Do **not** create or maintain a "KPI Actuals" section in SALES_STRATEGY.md.

Sub-agent's return to main: Briefly report the notification email send status.
