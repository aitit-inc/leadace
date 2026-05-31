---
name: evaluate
description: "This skill should be used when the user asks to \"analyze results\", \"improve strategy\", \"run PDCA\", \"evaluate effectiveness\", \"check response rates\", or wants to evaluate sales performance and improve strategy. Automatically analyzes and improves strategy, targeting, and messaging based on response rate data."
argument-hint: "<project-id>"
allowed-tools:
  - Bash
  - Read
  - WebSearch
  - mcp__plugin_leadace_api__get_eval_data
  - mcp__plugin_leadace_api__get_rejection_feedback_summary
  - mcp__plugin_leadace_api__get_evaluation_history
  - mcp__plugin_leadace_api__record_evaluation
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__save_document
  - mcp__plugin_leadace_api__get_master_document
---

# Evaluate - PDCA Evaluation & Improvement

A skill that analyzes sales activity result data and automatically evaluates and improves every aspect -- strategy, tactics, targeting, and messaging.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Data Collection

- Project ID: `$0` (required)

In parallel, call:
- `mcp__plugin_leadace_api__get_eval_data` with `projectId: "$0"`
- `mcp__plugin_leadace_api__get_rejection_feedback_summary` with `projectId: "$0"`, `windowDays: 30`, `scope: "tactical"`

If `get_eval_data` returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

`get_eval_data` response includes:
- `metrics`: totalOutreach, channelCounts, responseCounts, sentimentBreakdown, priorityResponseRate, statusCounts, channelResponseRate, inquiryOutcomeCounts
  - `metrics.inquiryOutcomeCounts`: per-project session totals keyed by outcome (`opened` / `inquired` / `lead` / `signup_clicked` / `unsubscribed`). `signup_clicked` is the self-serve conversion path (project's CTA mode is `signup`, visitor clicked the Sign up button); `lead` is the human-sales conversion (meeting requested, button or chat-derived). Both `signup_clicked` and `lead` flip `project_prospects.status` to `responded`, so the prospect drops out of the outbound pool — they are different conversion axes that both belong in the "won" column
- `respondedMessages`: all outreach bodies that received responses (with sentiment and responseType)
- `noResponseSample`: sample of outreach bodies that received no response
- `dataSufficiency`: `{ sufficient, totalSent, daysSinceLastSend }`

`get_rejection_feedback_summary` (scope="tactical", windowDays=30) response includes:
- `total`, `primaryReasonDistribution`: counts of `not_relevant` / `wrong_timing` / `budget` / `not_decision_maker` / `unsubscribe_request` / `other`
- `recontactWindows`: per-window buckets keyed by `never` / `3_months` / `6_months` / `12_months` / `unspecified`. Each bucket carries `count` (total rejections that cited that window) and `samples` (most recent prospects, up to `recontactLimit`). All five buckets are always present — empty ones carry `{count: 0, samples: []}`. Prospects in time-bounded buckets are auto-deferred (`next_outreach_after` set on rejection; `get_outbound_targets` skips them until the window passes); `never` is a hard opt-out (DNC ratchet). Informational
- `decisionMakerPointers`: prospects that pointed to a different decision-maker — auto-prospect-created at record_response time (new prospect linked to every project the referring prospect is in, or role updated on an existing same-org contact), surface here as a transparency log only
- `notRelevantNotes`: per-row data with `industry`, `organizationName`, `freeText` — drives targeting hints in step 4

If `get_rejection_feedback_summary` errors, continue with the eval data only and note the failure in the report.

### 2. Load Existing Strategy

Load documents via MCP:

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "business"`.
Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "sales_strategy"`.

Call `mcp__plugin_leadace_api__get_evaluation_history` with `projectId: "$0"` to retrieve past evaluation records.

If past evaluations exist, organize each record's `evaluationDate`, `findings`, and `improvements` chronologically to understand what has been tried, what was effective, and what was not. Use this information when deciding on improvement actions in step 4.

### 3. Multi-angle Analysis

Retrieve analysis frameworks via `mcp__plugin_leadace_api__get_master_document` with `slug: "tpl_analysis_frameworks"` and analyze from the following perspectives:

**Response Rate Analysis:**
- Overall response rate
- Response rate by channel (email vs form vs SNS)
- Response rate by priority
- Trends by time of day and day of week (analyze from send timestamps. However, since sending timing is determined by the daily-cycle execution schedule, do not write sending time constraints in SALES_STRATEGY.md. Report analysis results as "recommended execution timing" in the report only)

**Message Analysis:**
- Read all outreach bodies that received responses (from `respondedMessages`) and extract common traits
- Compare with non-response samples (from `noResponseSample`)
- Effectiveness of subject lines
- Effectiveness of body length and structure

**Target Analysis:**
- Industries and sizes with good responses
- Segments with poor responses
- Unexpected response patterns

**Channel Analysis:**
- Most effective channel
- Cost-effectiveness by channel

**Rejection Tactical Analysis (from `get_rejection_feedback_summary` scope="tactical"):**
- `primaryReasonDistribution`: which tactical reasons dominate (e.g. `not_relevant` heavy → targeting issue; `wrong_timing` / `budget` heavy → pipeline issue; `not_decision_maker` heavy → outreach is reaching wrong contacts)
- `notRelevantNotes`: group rows by `industry` (and by `organizationName` when industries are missing). An industry with multiple `not_relevant` hits is a targeting-mismatch signal — use it in step 4 to update SEARCH_NOTES
- `recontactWindows`: per-bucket `count` across all five windows. `never` is a hard opt-out (DNC ratchet). `3_months` / `6_months` / `12_months` are auto-deferred via `prospects.next_outreach_after` and re-enter the outbound queue automatically when the window passes. `unspecified` defers using the project-configured `unspecifiedRecontactWindowMonths` fallback — a heavy `unspecified` count argues for tuning that setting. `samples` lists representative prospects for each non-empty bucket. Surface in the report as a transparency log only
- `decisionMakerPointers`: each row is a referral to another contact. Auto-prospect-creation runs at record_response time (pointer with email creates a new prospect; pointer with name only updates an existing same-org contact's role). Surface in the report as a transparency log

### 4. Determine and Apply Improvement Actions

**Data volume check (required):**

Use the `dataSufficiency` field from step 1. If `sufficient` is `false`, **do not apply changes to SALES_STRATEGY.md or recalculate priorities**. Only run report generation (steps 5 and 6) and report "Insufficient data -- continue monitoring":
- Total approaches (status='sent') fewer than 30
- Less than 3 business days since last send

Even with insufficient data, still record to the evaluations table (step 5) and generate the report (step 6) -- they are useful for understanding current status.

---

When data is sufficient, decide on specific improvements based on analysis results and **apply them automatically**.

**Strategy change stability (required):**
Evaluate runs daily, but avoid changing strategy too frequently. Until sufficient data has accumulated after the last strategy change, maintain the current strategy and prioritize data collection.

What counts as "sufficient data" depends on context. For high-volume projects, a few response fluctuations are noise, but for precision approaches, even a single response can be an important signal. Judge based on the target scale and send frequency in SALES_STRATEGY.md.

Judgment principles:
- Change based on **patterns observed repeatedly, not one-off fluctuations**
- If the **effect of the last strategy change cannot yet be measured**, do not layer additional changes
- When in doubt, don't change. Accumulating data is more valuable than changing direction on weak evidence

**Cross-reference with improvement history (required):**
Before deciding on improvement actions, review the past evaluations history organized in step 2 and follow these rules:
- Do not re-adopt measures that were tried before and had no effect
- Continue and deepen the direction of measures that were effective before
- If proposing the same improvement as before, state why different results are expected this time

**Update SALES_STRATEGY.md:**
- Narrow or broaden targeting
- Improve messaging (subject line, body structure, tone)
- Revise channel priority
- Update KPI goals

Save the updated document via `mcp__plugin_leadace_api__save_document` with `projectId: "$0"`, `slug: "sales_strategy"`, and the full markdown content.

**Update search keywords:**
- Add keywords related to high-response segments
- Remove ineffective keywords

**Reflect response patterns in SEARCH_NOTES.md:**
Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "search_notes"`. If found, update the `## Hints from evaluate` section (add it at the end if not present) and save via `save_document`. build-list will preserve this section during the next run and adjust its search policy.

Content to add:
- Industries / segments with response rates above overall average -> "XX industry has X% response rate (vs overall average Y%). Explore more of this industry"
- Characteristics similar to companies that responded (scale, business content, pain points) -> "Companies like XX respond well. Search for similar companies and competitors"
- Segments with poor responses -> "XX industry has low response rate (X%). Lower priority"
- **Industries with `not_relevant` rejection clusters** (from `notRelevantNotes` grouped by `industry`): if ≥2 rows in the same industry, add "XX industry has N `not_relevant` rejections — targeting mismatch, lower priority". Skip industries with only 1 hit (noise)

Skip if the document is not found (build-list hasn't been run yet).

**Recalculate priorities:**
- Update prospect priorities based on response patterns (bulk execution in step 5)

### 5. Save Evaluation Record

Call `mcp__plugin_leadace_api__record_evaluation` with:
- `projectId`: "$0"
- `metrics`: the metrics object from step 1 (excluding respondedMessages and noResponseSample)
- `findings`: analysis findings text from step 3
- `improvements`: summary of improvement actions applied (or "Insufficient data -- no changes applied")
- `priorityUpdates` (optional): array of `{ industry, priority }` for bulk priority updates. Omit if no priority changes due to insufficient data.

### 6. Results Report

Report the following directly to the user (no file output needed -- evaluation data is stored in the DB):
- Key KPIs (response rate, positive rate, etc.)
- **Inquiry landing conversions** (from step 1's `inquiryOutcomeCounts`): show whenever any of `lead` / `signup_clicked` / `inquired` / `unsubscribed` is non-zero. Report `lead` (meeting-request conversions) and `signup_clicked` (self-serve signup conversions) separately — they reflect different CTA modes and inform whether the project's chosen CTA is converting. Skip the section when all five outcomes are 0
- Changes from previous evaluation (if any)
- Important findings from the analysis
- List of improvements applied
- **Tactical rejection signals** (from step 1's `get_rejection_feedback_summary`):
  - Tactical reason distribution (counts by `not_relevant` / `wrong_timing` / `budget` / `not_decision_maker` / `unsubscribe_request` / `other`). Show whenever tactical `total` > 0 — non-recontact reasons like `not_relevant` and `unsubscribe_request` still belong here
  - **Recontact queue** — for each non-empty bucket in `recontactWindows` (`never` / `3_months` / `6_months` / `12_months` / `unspecified`), report `count` and list the `samples` entries (organization, prospect name). State that time-bounded buckets are auto-deferred (`prospects.next_outreach_after` set on rejection) and will re-enter the outbound queue automatically once the window passes; `never` is a hard DNC opt-out, not a recontact. Omit this sub-bullet when every bucket has `count: 0`
  - **Decision-maker referrals** — list `decisionMakerPointers` rows (referring prospect → pointer name/email/role). State that auto-prospect-creation runs at record_response time (pointer with email creates a new prospect linked to the same projects; pointer with name only updates an existing same-org contact's role/department), so no manual registration is required. Omit this sub-bullet when `decisionMakerPointers` is empty
  - Skip the whole section only when tactical `total` is 0 (no tactical rejections at all)
- Next actions to take (`/build-list` for additional exploration, `/outbound` for re-approach, etc.)
