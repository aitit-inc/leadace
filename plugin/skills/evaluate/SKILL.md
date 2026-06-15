---
name: evaluate
description: "This skill should be used when the user asks to \"analyze results\", \"improve strategy\", \"run PDCA\", \"evaluate effectiveness\", \"check response rates\", or to evaluate and improve sales performance. Reports metrics, applies priority + targeting updates."
argument-hint: "<project-id>"
allowed-tools:
  - Bash
  - Read
  - WebSearch
  - mcp__plugin_leadace_api__get_eval_data
  - mcp__plugin_leadace_api__get_rejection_feedback_summary
  - mcp__plugin_leadace_api__get_evaluation_history
  - mcp__plugin_leadace_api__get_lever_state
  - mcp__plugin_leadace_api__get_lever_decisions
  - mcp__plugin_leadace_api__list_subject_variants
  - mcp__plugin_leadace_api__upsert_subject_variant
  - mcp__plugin_leadace_api__record_evaluation
  - mcp__plugin_leadace_api__get_document
  - mcp__plugin_leadace_api__save_document
  - mcp__plugin_leadace_api__get_master_document
---

# Evaluate - PDCA Evaluation & Improvement

A skill that analyzes sales activity result data, reports on performance, and applies the improvements it still owns — numeric priorities and targeting / search keywords. Messaging (subject lines) and channel ranking are now optimized deterministically by the daily lever tick; evaluate **reads and narrates** those, it does not rewrite them as strategy prose.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Data Collection

- Project ID: `$0` (required)

In parallel, call:
- `mcp__plugin_leadace_api__get_eval_data` with `projectId: "$0"`
- `mcp__plugin_leadace_api__get_rejection_feedback_summary` with `projectId: "$0"`, `windowDays: 30`, `scope: "tactical"`
- `mcp__plugin_leadace_api__get_lever_state` with `projectId: "$0"` — current subject draw weights, channel affinity, and per-variant maturity (read-only)
- `mcp__plugin_leadace_api__get_lever_decisions` with `projectId: "$0"` — the daily tick's decision history (newest first) for trend narration

If `get_eval_data` returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

`get_eval_data` response includes:
- `metrics`: totalOutreach, channelCounts, responseCounts, sentimentBreakdown, priorityResponseRate, statusCounts, channelResponseRate, variantResponseRate, inquiryOutcomeCounts
  - `variantResponseRate` / `channelResponseRate` / `priorityResponseRate` are the **measured lever surfaces**. The subject and channel levers act on them automatically (lever tick) — read them to report, do not turn them into SALES_STRATEGY edits
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

Call `mcp__plugin_leadace_api__get_document` with `projectId: "$0"` and `slug: "learnings"` to load the current Learnings Log — the distilled, evidence-cited learnings this skill routes to build-list and outbound. You will reconcile and update it in step 4. Skip if missing (you may create it in step 4).

### 3. Multi-angle Analysis

Retrieve analysis frameworks via `mcp__plugin_leadace_api__get_master_document` with `slug: "tpl_analysis_frameworks"` and analyze from the following perspectives:

**Response Rate Analysis:**
- Overall response rate
- Response rate by channel (email vs form vs SNS)
- Response rate by priority
- Trends by time of day and day of week (analyze from send timestamps. However, since sending timing is determined by the daily-cycle execution schedule, do not write sending time constraints in SALES_STRATEGY.md. Report analysis results as "recommended execution timing" in the report only)

**Message Analysis (the subject lever applies — narrate it, don't rewrite SALES_STRATEGY; body traits feed the `[body]` Learnings Log entry):**
- Read all outreach bodies that received responses (from `respondedMessages`) and extract common traits
- Compare with non-response samples (from `noResponseSample`)
- Effectiveness of subject lines (cross-reference `variantResponseRate` and the lever weights)
- Effectiveness of body length and structure

These feed the Step 6 report and the `[body]` entries of the Learnings Log (step 4). Do **not** translate them into SALES_STRATEGY messaging edits — subject-line optimization is owned by the lever tick.

**Target Analysis:**
- Industries and sizes with good responses
- Segments with poor responses
- Unexpected response patterns

**Channel Analysis (the channel lever applies — narrate it, don't rewrite SALES_STRATEGY; channel-usage traits feed the `[channel]` Learnings Log entry):**
- Most effective channel (cross-reference `channelResponseRate` and the lever's `channelAffinity`)
- Cost-effectiveness by channel

These feed the Step 6 report and the `[channel]` entries of the Learnings Log (step 4 — how to *use* a channel; channel selection itself stays lever-owned). Do **not** translate them into SALES_STRATEGY channel-priority edits — channel ranking is owned by the lever tick.

**Rejection Tactical Analysis (from `get_rejection_feedback_summary` scope="tactical"):**
- `primaryReasonDistribution`: which tactical reasons dominate (e.g. `not_relevant` heavy → targeting issue; `wrong_timing` / `budget` heavy → pipeline issue; `not_decision_maker` heavy → outreach is reaching wrong contacts)
- `notRelevantNotes`: group rows by `industry` (and by `organizationName` when industries are missing). An industry with ≥2 `not_relevant` hits is a targeting-mismatch signal (1 hit is noise) — feed it into step 4's `[targeting]` Learnings Log entry
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

**Update SALES_STRATEGY.md (targeting & KPI only):**
- Narrow or broaden targeting
- Update KPI goals

Do **not** edit messaging (subject line / body) or channel priority here — those are optimized deterministically by the daily lever tick (subject draw weights, channel affinity). Report their measured performance in Step 6; do not encode it as prose. (Tone/sub-channel preferences a user wrote in SALES_STRATEGY stay as their authored hints; evaluate just doesn't rewrite them.)

Save the updated document via `mcp__plugin_leadace_api__save_document` with `projectId: "$0"`, `slug: "sales_strategy"`, and the full markdown content.

**Update search keywords:**
- Add keywords related to high-response segments
- Remove ineffective keywords

**Update the Learnings Log (the cross-stage self-improvement memory):**

The `learnings` document is the distilled, evidence-cited memory that build-list and outbound read each cycle — it is how a learning from one cycle re-enters every downstream stage automatically. Its honesty is enforced *here, at the write*.

Each entry is one line: `[stage] [YYYY-MM-DD] claim — evidence: metric=<name>, n=<sample>`. Stage tags, one per downstream decision a skill can act on:
- `[targeting]` — segments to collect / prioritize (read by build-list). Source: per-segment reply rates, `notRelevantNotes` targeting-mismatch clusters (the ≥2 rule from step 3).
- `[body]` — what responding messages do that non-responding ones don't (read by outbound, composition hint). Source: Message Analysis traits.
- `[timing]` — recontact-window / cadence patterns that converted (read by outbound). Source: priority / recontact data.
- `[channel]` — how to *use* a channel well (tone, opener), NOT which channel to pick (lever-owned). Read by outbound as color only.

**Write gate — all required; a claim that can't meet these is a hunch, drop it:**
- `dataSufficiency.sufficient` is true and the stability discipline above says it is time to act.
- The entry cites a measured metric and its sample size, with `n ≥ minSamplePerArm` (from step 1's `get_lever_state`).
- The pattern repeated across cycles, not a one-off fluctuation.

**Reconcile before adding (the effect-measurement loop):**
- Re-check each existing entry's cited metric against this cycle. If its direction no longer reproduces, retire it: replace its leading tag with `[retired]`, keeping the rest of the line (`[retired] [YYYY-MM-DD] claim — evidence: …`). `[retired]` is a tombstone, not a stage tag — readers skip it; it stays only so a disproven claim isn't re-added. Cheap because the metric + n is already on the line.
- Keep ≤15 active (non-retired) entries; over the cap, retire weakest-evidence or oldest first.

Save the full list via `mcp__plugin_leadace_api__save_document` with `projectId: "$0"` and `slug: "learnings"`. When `dataSufficiency` is insufficient, do not write — an empty / unchanged log is the correct early state.

**Boundary:** learnings *steer* downstream LLM authoring and collection; they are never deterministic selectors and never edit SALES_STRATEGY messaging or channel priority (the levers own those). Frame each as "what the data shows."

**Replenish the subject-variant pool (supply candidates, never pick winners):**
The lever tick prunes and re-weights subject variants but never *generates* new ones, so a converged pool plateaus on its least-bad seeds. Close that gap here — supply, don't select:
- **When to act:** only when step 1's `get_lever_state` returns `needsReplenishment: true` (the optimizer has converged to the two-active floor with a dominated arm). If it is false, do nothing.
- **Guardrails:** the same gates as every change above — skip if `dataSufficiency` is insufficient, if the stability discipline says wait, or if a previously supplied variant has not yet matured (don't stack ungrown candidates).
- **What to produce:** read `list_subject_variants` first (so you see the active and recently-archived angles), then add **exactly one** new subject pattern that is a *genuinely distinct angle* from every active one — ≤80 chars, only `{{org}}` / `{{name}}` / `{{signal}}` placeholders, matching the SALES_STRATEGY voice, no fabricated company-specific claims. Upsert via `upsert_subject_variant` with a fresh generation-namespaced slug — `[A-Za-z0-9_-]`, ≤32 chars (e.g. `gen_20260607`); never reuse the `v1` / `v2` / `v3` seed slugs (that overwrites a live seed).
- **Boundary (report-only intact):** this hands the bandit a new arm to *test* — it does not assert the new angle is better and does not edit SALES_STRATEGY messaging. Frame it as "an angle to test," not "a better subject."

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
- **Lever observability (apply + monitor)** (from step 1's `get_lever_state` / `get_lever_decisions`): make the automatic optimization visible so it is not a black box. Narrate:
  - **Subject & channel levers (controlled)**: which subject variants lead and their maturity (`total` vs `minSamplePerArm`), any recently archived variants, and the measured `channelAffinity` per coarse-industry bucket — plus how these moved across the recent ticks (the decision history is the trend). If you supplied a fresh subject angle this run (pool replenishment), name it and say the tick will trend it. Say "uniform / none yet" when there isn't enough data
  - **Timing & priority levers (no control arm)**: these are applied and monitored, never A/B-tested or auto-reverted. Surface their monitoring view — `priorityResponseRate` and the recontact / timing signals above — and call out notable shifts for the operator to judge
  - Skip lines with no data yet (fresh project)
- Next actions to take (`/build-list` for additional exploration, `/outbound` for re-approach, etc.)
