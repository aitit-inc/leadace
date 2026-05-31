---
name: daily-cycle
description: "This skill should be used when the user asks to \"run the daily cycle\", \"run today's sales\", \"do the daily sales tasks\", \"run daily-cycle\", or wants to run the daily sales automation cycle. Automatically runs check-results -> evaluate -> outbound + build-list (when needed) in sequence."
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
  - mcp__plugin_leadace_api__record_response
  - mcp__plugin_leadace_api__update_prospect_status
  - mcp__plugin_leadace_api__get_eval_data
  - mcp__plugin_leadace_api__get_evaluation_history
  - mcp__plugin_leadace_api__record_evaluation
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

- Call `mcp__plugin_leadace_api__get_evaluation_history` with `projectId: "$0"` to check the latest evaluation (findings, improvements)
- Call `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1` to get the current reachable count

Use this information to inform subsequent steps when relevant. For example:
- If reachable count is very low -> Run build-list earlier
- If recent evaluation shows low response rates on a channel -> Inform outbound sub-agent

### 3. Start Notification Email

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"` to get the notification recipient email from the "Notification Settings" section. Skip if notification is "none" or not set. (The sender is the user's connected Gmail address — no manual sender lookup needed.)

Compose the email body concisely using only information already on hand -- no additional queries:
- Execution date and time (result from step 1)
- Project name (`$0`)
- Outbound target count (`$1`)
- Results from previous cycle (1-2 lines extracted from DAILY_CYCLE_REPORT.md in step 2; omit for first run)

Call `mcp__plugin_leadace_api__send_email` with the notification recipient as `to`, subject `"daily-cycle started: $0"`, and the body. (Use `send_email`, not `send_email_and_record` — this notification is not prospect outreach and should not be logged.)

If sending fails (e.g. Gmail not connected), continue the cycle (errors will be reported in the wrap-up report).

### 4. check-results (sub-agent)

Launch a sub-agent using the Agent tool to check for replies.

Include the following in the prompt:
- Project ID: `$0`
- Read `${CLAUDE_PLUGIN_ROOT}/skills/check-results/SKILL.md` and follow its procedure
- Return to main with **only a 3-line summary**. Example: "3 responses (positive 2, neutral 1). 2 drafts created. 0 do-not-contacts."

After receiving the summary from the sub-agent, report it to the user.

### 5. evaluate (sub-agent, conditional)

Run every cycle.

Include the following in the prompt:
- Project ID: `$0`
- Read `${CLAUDE_PLUGIN_ROOT}/skills/evaluate/SKILL.md` and follow its procedure
- Return to main with **only a 3-line summary**. Example: "Response rate 4.2%. Messaging improvement applied. 2 search keywords added."

After receiving the summary from the sub-agent, report it to the user.

### 6. Check List Remaining and Determine Execution Order

Check the number of reachable prospects (status = 'new' plus 'deferred' prospects whose recontact window has passed):

Call `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1`.

Read the `total` and `byChannel` fields from the response:
- `total`: total reachable count
- `byChannel.email`: prospects with email
- `byChannel.formOnly`: prospects with form only (no email)
- `byChannel.snsOnly`: prospects with SNS only (no email or form)

**Email depletion check:** If `byChannel.email` = 0 and `byChannel.formOnly` < 5, outbound effectiveness will be very low. In this case, skip outbound and **run step 8 (build-list) first** to replenish email holders. After replenishment, re-run step 6; if email > 0, proceed to outbound. If email = 0 even after build-list, run outbound for the number of formOnly prospects (report the email depletion state to the user).

**Execution order determination:** If `total` is less than **1/3 of the specified outbound count**, run step 8 (build-list) first to replenish the list, then return to step 7 outbound.

- email = 0 and formOnly < 5 -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)
- total >= 1/3 of specified count -> step 7 (outbound) -> step 8 (build-list, if needed)
- total < 1/3 of specified count -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)
- total = 0 and build-list not yet run -> step 8 (build-list) -> re-run step 6 -> step 7 (outbound)

### 7. outbound (sub-agents x batch split)

**Determine actual outbound count:** Use `min(specified count, total from step 6)` as the actual outbound count. If total is 0 (including after step 8), skip outbound and proceed to step 9.

**Form submission limit:** Cap form submissions at **5 per cycle**. Form submissions consume 10-20 tool calls each via browser operations and are the primary cause of context exhaustion. If `formOnly` from the step 6 channel breakdown exceeds 5, carry the excess over to the next cycle. No limit for prospects with email.

Split the outbound count into **batches of 10** and launch each as a **separate sub-agent in series**.

Example: 30 prospects -> 3 sub-agent launches (10 each)

Include the following in each sub-agent's prompt:

```
You are an outbound sales agent. Please reach out to each company on the prospect list via email, form, or SNS DM.

## Preparation (read in this order)

1. First retrieve strategy documents via MCP:
   - Call mcp__plugin_leadace_api__get_document with projectId "$0" and slug "business"
   - Call mcp__plugin_leadace_api__get_document with projectId "$0" and slug "sales_strategy"
   - (env_status is loaded later by outbound/SKILL.md step 1 — do not fetch it here)
   Understand:
   - Outreach mode (precision / volume). Default to precision if not set
   - SALES_STRATEGY "Sales Channels" section: tactical preferences only (ordering, tone, sub-channel preferences). Channel enablement is owned by `outboundChannels` in project settings (gated in outbound/SKILL.md step 1; in send mode, outbound also pre-flights env_status and aborts if any enabled channel's tool is missing).
   - Subject line pattern variations (if A/B test instructions exist, follow them)
   - Email body structure and template (especially important in volume mode)
   - Sender information: signature block only (sender display name + email live in project settings and are applied automatically by `send_email` / `send_email_and_record`)
   - SNS messaging policy

2. Next, read `${CLAUDE_PLUGIN_ROOT}/skills/outbound/SKILL.md` and follow its procedure

3. Also read these based on the channel:
   - For email: retrieve via mcp__plugin_leadace_api__get_master_document with slug "tpl_email_guidelines"
   - For forms: read `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/form-filling.md` and `${CLAUDE_PLUGIN_ROOT}/skills/outbound/references/claude-in-chrome-guide.md`

## Required Rules for Sales Policy

- **Subject lines:** Subject patterns live server-side in `subject_variants`. Per send, call `mcp__plugin_leadace_api__pick_subject_variant` for the next round-robin variant and forward `variantId` to `send_email_and_record` so `outreach_logs.variant_id` is stamped. If no active variants are registered, generate a one-off subject and send without `variantId`. Do not use the same subject for every prospect.
- **Email opening:** Reference specific characteristics, industry, or initiatives of the target company. Generic greetings like "I visited your website" alone are not acceptable
- **Full body:** Weave prospect-specific information from overview and matchReason throughout multiple parts of the email -- write in context tailored to the recipient, not template replacement. The compliance footer (legal name, address, privacy, unsubscribe) is appended server-side; do **not** include any of those in the body.

## Task

- Project ID: $0
- Batch number: N
- Count: 10 (final batch may be fewer)
- Retrieve prospects via mcp__plugin_leadace_api__get_outbound_targets with projectId "$0" and limit 10
- For each prospect, follow `${CLAUDE_PLUGIN_ROOT}/skills/outbound/SKILL.md`'s channel-pick + send sequence. The skill picks one MCP per channel (`send_email_and_record` for email, `record_outreach_with_inquiry` for form/SNS) and uses `record_outreach` with status='failed' only for skips and post-hoc failures — do **not** call `record_outreach` after each successful send (that path bypasses the compliance footer and would double-log).
- Country pre-flight: skip non-US/CA/JP targets up front via `record_outreach` status='failed' with `errorMessage:"skipped: country not supported"`; do not attempt the send tool for those.
- Return to main with **only: success count, failure count, inactive count, main failure reasons (if any), list of variantIds used**
  Example: "Success 8, Failure 1 (form submission error), Unreachable 1. Variants: v1 x 4, v2 x 3, v3 x 3"
```

**Carry over previous batch results:** From the 2nd batch onward, append the variant usage from the previous batch to the prompt so the sub-agent can pass an explicit `variantId` to `pick_subject_variant` if it wants to even out coverage. Example: "Previous batch used v1 x 4, v2 x 3. Skew toward v2 / v3 this time."

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
- After completion, return the candidate list as a JSON array (each object: name, organization_name, website_url, overview, industry, country, match_reason, priority (numeric 1-5 per build-list SKILL.md definition))
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
- Plus all other fields: `name`, `overview`, `websiteUrl`, `email`, `contactFormUrl`, `formType`, `snsAccounts`, `matchReason`, `priority`, etc.
- **At least one of `email`, `contactFormUrl`, `snsAccounts` must be set** (prospects without contact channel are rejected)

The server returns `skippedDetails` with `{name, reason}` for rows it dedup-rejected (`already_in_project` / `email_duplicate` / `form_url_duplicate` / `do_not_contact` / `duplicate_in_batch`). Surface the breakdown in the completion report so the user can see how much of the candidate pool was already covered.

**8d. Reachable recheck and summary output**

After build-list completes, re-check reachable count via `mcp__plugin_leadace_api__get_outbound_targets` with `projectId: "$0"` and `limit: 1`.

Report build-list summary (added count, reachable count, etc.) to the user.

If step 6 determined to run build-list first, proceed to step 7 (outbound) from here.

### 9. wrap-up (sub-agent)

**After all phases complete, execute KPI update and notification in a single sub-agent.**

Include the following in the prompt:
- Project ID: `$0`
- Execution date and time: the datetime obtained in step 1
- Phase summaries collected from sub-agents during this cycle (check-results, evaluate, outbound, build-list)

**9a. Update KPI Actual Results in SALES_STRATEGY.md**

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"`. If the document has a "KPI Actuals" section, update the following basic numbers with the latest values:
- Total sent (contacted)
- Total responses and response rate
- Execution date and time

Save via `mcp__plugin_leadace_api__save_document` with `projectId: "$0"`, `slug: "sales_strategy"`, and the updated content.

This prevents KPI actuals from becoming stale even in cycles where evaluate is skipped. Leave messaging improvements, targeting changes, and other strategic analysis to the evaluate skill -- **only update numbers here**.

**9b. Completion Notification Email**

Get the notification recipient email from the "Notification Settings" section of the sales_strategy document (already loaded in 9a). Skip if notification is "none" or not set. The `From:` address is applied automatically by `send_email` from project settings (`senderEmailAlias` / `senderDisplayName`) — do not pass them as arguments.

Compose the report body from the phase summaries passed in the prompt:

```
Daily Cycle Report — YYYY-MM-DD HH:MM
Project: $0

check-results: (summary)
evaluate: (summary)
outbound: (summary)
build-list: (summary)
```

Call `mcp__plugin_leadace_api__send_email` with the notification recipient as `to`, subject `"daily-cycle completed: $0"`, and the report body. (Use `send_email`, not `send_email_and_record` — this is an internal report, not prospect outreach.)

Sub-agent's return to main: Briefly report the KPI update status and notification email send status.
