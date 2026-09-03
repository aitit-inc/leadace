---
name: evaluate
description: "This skill should be used when the user asks to \"analyze results\", \"improve strategy\", \"run PDCA\", \"evaluate effectiveness\", \"check response rates\", or to evaluate and improve sales performance. Reports metrics, applies targeting + discovery-portfolio updates."
argument-hint: "<project-id>"
allowed-tools:
  - Bash
  - Read
  - WebSearch
  - mcp__plugin_leadace_leadace__get_eval_data
  - mcp__plugin_leadace_leadace__get_rejection_feedback_summary
  - mcp__plugin_leadace_leadace__get_lever_state
  - mcp__plugin_leadace_leadace__get_lever_decisions
  - mcp__plugin_leadace_leadace__list_message_variants
  - mcp__plugin_leadace_leadace__upsert_message_variant
  - mcp__plugin_leadace_leadace__upsert_discovery_strategy
  - mcp__plugin_leadace_leadace__record_suggestion
  - mcp__plugin_leadace_leadace__get_document
  - mcp__plugin_leadace_leadace__save_document
  - mcp__plugin_leadace_leadace__get_master_document
---

# Evaluate - PDCA Evaluation & Improvement

A skill that analyzes sales activity result data, reports on performance, and applies the improvements it still owns — targeting definitions / search keywords (hypothesis generation that steers /build-list) and the discovery-strategy portfolio (the registry managed via `upsert_discovery_strategy`). Messaging (message angles), channel ranking, and the outbound selection order (measured targeting lifts × ordering score) are optimized deterministically by the daily lever tick; evaluate **reads and narrates** those, it does not rewrite them as strategy prose and it does not touch selection order.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Data Collection

- Project ID: `$0` (required)

In parallel, call:
- `get_eval_data` with `projectId: "$0"`
- `get_rejection_feedback_summary` with `projectId: "$0"`, `windowDays: 30`, `scope: "tactical"`
- `get_lever_state` with `projectId: "$0"` — current message-variant draw weights, channel affinity, targeting lifts, per-variant maturity, and the discovery block (`discovery.strategies`: slug / approach / archived state; `discovery.weights`: the tick's strategy draw weights; `discovery.needsReplenishment`) (read-only)
- `get_lever_decisions` with `projectId: "$0"` — the daily tick's decision history (newest first) for trend narration

If `get_eval_data` returns a "Project not found" error, instruct the user to run `/leadace` first and **abort**.

`get_eval_data` response includes:
- `metrics`: totalOutreach, channelCounts, responseCounts, sentimentBreakdown, priorityResponseRate, statusCounts, channelResponseRate, variantResponseRate, discoveryStrategyResponseRate, industryResponseRate, sizeResponseRate, countryResponseRate, freshSignalResponseRate, inquiryOutcomeCounts
  - `variantResponseRate` / `channelResponseRate` / `priorityResponseRate` are the **measured lever surfaces**. The message and channel levers act on them automatically (lever tick) — read them to report, do not turn them into SALES_STRATEGY edits
  - `discoveryStrategyResponseRate`: per named discovery strategy — reply rate PLUS `bounces` / `bounceRate` (bounces as a percentage of threadable email sends, 1dp — same units as `rate`). Reply metrics (`total` / `responses` / `rate`) count **mature sends only**; bounce metrics span all sends so the source-quality read never lags the maturity window — a young strategy can honestly show `total: 0` with non-zero bounces, which means "sends not mature yet", never "this strategy produced nothing". The `strategy: null` bucket is prospects without recorded provenance (manual/CSV imports, referrals, pre-provenance rows) — treat it as a baseline, not a strategy, and never demote it. The same applies to a slug that is not in this project's registry (`get_lever_state` → `discovery.strategies`) — e.g. carried by prospects linked in from another project: baseline-only, not an arm this project manages. **Evaluate owns the registry side of this lever** — register / archive via `upsert_discovery_strategy` in step 4, on evidence the tick cannot see; reply-rate selection is the tick's call. `bounceRate` is an *early* source-quality read (bounces arrive before replies): a high or rising per-strategy bounceRate means that source finds unreachable people. It is a threaded-only LOWER bound (real bounce rate is ≥ shown), so act on it when high, never read a low value as proof a source is clean
  - `industryResponseRate` / `sizeResponseRate` / `countryResponseRate`: targeting observation axes — reply-rate splits by coarse industry bucket, organization employee band, and effective recipient country (prospect override, else org). Like the strategy axis above they count **mature sends only** (older than the reply-maturity window), so fresh sends don't dilute them; each bucket also carries `bounces` / `bounceRate` with the same threaded-only caveat as `discoveryStrategyResponseRate`. Report-level observation for the Target Analysis — ground segment claims in these measured splits instead of impressions
  - `freshSignalResponseRate`: `{ withSignal, withoutSignal }` reply-rate split by whether a fresh why-now org signal existed at compose time — the first measured read of whether signal-led sends convert better. Report-level observation only
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

Call `get_document` with `projectId: "$0"` and `slug: "business"`.
Call `get_document` with `projectId: "$0"` and `slug: "sales_strategy"`.

Call `get_document` with `projectId: "$0"` and `slug: "learnings"` to load the current Learnings Log — the distilled, evidence-cited learnings this skill routes to build-list and outbound, and the single memory of what has been tried and whether it worked (its `[retired]` tombstones record disproven claims so they are not re-adopted). You will reconcile and update it in step 4, and cross-reference it when deciding improvement actions. Skip if missing (you may create it in step 4).

### 3. Multi-angle Analysis

Retrieve analysis frameworks via `get_master_document` with `slug: "tpl_analysis_frameworks"` and analyze from the following perspectives:

**Response Rate Analysis:**
- Overall response rate
- Response rate by channel (email vs form vs SNS)
- Response rate by priority
- Trends by time of day and day of week (analyze from send timestamps. However, since sending timing is determined by the daily-cycle execution schedule, do not write sending time constraints in SALES_STRATEGY.md. Report analysis results as "recommended execution timing" in the report only)

**Message Analysis (the message lever applies — narrate it, don't rewrite SALES_STRATEGY; body traits feed the `[body]` Learnings Log entry):**
- Read all outreach bodies that received responses (from `respondedMessages`) and extract common traits
- Compare with non-response samples (from `noResponseSample`)
- Effectiveness of message angles (cross-reference `variantResponseRate` and the lever weights)
- Effectiveness of body length and structure

These feed the Step 5 report and the `[body]` entries of the Learnings Log (step 4). Do **not** translate them into SALES_STRATEGY messaging edits — subject-line optimization is owned by the lever tick.

**Target Analysis:**
- Industries and sizes with good responses — ground these in the measured `industryResponseRate` / `sizeResponseRate` / `countryResponseRate` splits (mature sends only), not impressions from reading bodies
- Segments with poor responses
- Unexpected response patterns
- Premise check: `notRelevantNotes` and reply texts against the Target's `Prerequisites` — report it even on insufficient data; step 4 acts

**Discovery Strategy Analysis (evaluate owns the registry side, acted on in step 4; reply-rate selection is the tick's):**
- Per-strategy sends and reply rate from `discoveryStrategyResponseRate`: which named strategies produce prospects that actually respond, which only produce volume
- Fresh-signal effect from `freshSignalResponseRate`: does a why-now signal at compose time correlate with responses at this project's n? Narrate the split honestly — small n means "no signal yet", not "signals don't work"

**Channel Analysis (the channel lever applies — narrate it, don't rewrite SALES_STRATEGY; channel-usage traits feed the `[channel]` Learnings Log entry):**
- Most effective channel (cross-reference `channelResponseRate` and the lever's `channelAffinity`)
- Cost-effectiveness by channel

These feed the Step 5 report and the `[channel]` entries of the Learnings Log (step 4 — how to *use* a channel; channel selection itself stays lever-owned). Do **not** translate them into SALES_STRATEGY channel-priority edits — channel ranking is owned by the lever tick.

**Rejection Tactical Analysis (from `get_rejection_feedback_summary` scope="tactical"):**
- `primaryReasonDistribution`: which tactical reasons dominate (e.g. `not_relevant` heavy → targeting issue; `wrong_timing` / `budget` heavy → pipeline issue; `not_decision_maker` heavy → outreach is reaching wrong contacts)
- `notRelevantNotes`: group rows by `industry` (and by `organizationName` when industries are missing). An industry with ≥2 `not_relevant` hits is a targeting-mismatch signal (1 hit is noise) — feed it into step 4's `[targeting]` Learnings Log entry
- `recontactWindows`: per-bucket `count` across all five windows. `never` is a hard opt-out (DNC ratchet). `3_months` / `6_months` / `12_months` are auto-deferred via `prospects.next_outreach_after` and re-enter the outbound queue automatically when the window passes. `unspecified` defers using the project-configured `unspecifiedRecontactWindowMonths` fallback — a heavy `unspecified` count argues for tuning that setting. `samples` lists representative prospects for each non-empty bucket. Surface in the report as a transparency log only
- `decisionMakerPointers`: each row is a referral to another contact. Auto-prospect-creation runs at record_response time (pointer with email creates a new prospect; pointer with name only updates an existing same-org contact's role). Surface in the report as a transparency log

### 4. Determine and Apply Improvement Actions

**Data volume check (required):**

Use the `dataSufficiency` field from step 1. If `sufficient` is `false`, **do not apply changes to SALES_STRATEGY.md**. Only run the report (step 5) and report "Insufficient data -- continue monitoring":
- Total approaches (status='sent') fewer than 30
- Less than 3 business days since last send

Even with insufficient data, still generate the report (step 5) -- it is useful for understanding current status.

---

When data is sufficient, decide on specific improvements based on analysis results and **apply them automatically**.

**Strategy change stability (required):**
Evaluate runs daily, but avoid changing strategy too frequently. Until sufficient data has accumulated after the last strategy change, maintain the current strategy and prioritize data collection.

What counts as "sufficient data" depends on context. For high-volume projects, a few response fluctuations are noise, but for precision approaches, even a single response can be an important signal. Judge based on the target scale and send frequency in SALES_STRATEGY.md.

Judgment principles:
- Change based on **patterns observed repeatedly, not one-off fluctuations**
- If the **effect of the last strategy change cannot yet be measured**, do not layer additional changes
- When in doubt, don't change. Accumulating data is more valuable than changing direction on weak evidence

**Cross-reference with the Learnings Log (required):**
Before deciding on improvement actions, review the Learnings Log loaded in step 2 (including its `[retired]` tombstones) and follow these rules:
- Do not re-adopt measures recorded as ineffective (a `[retired]` entry is a disproven claim kept precisely so it is not re-tried)
- Continue and deepen the direction of measures that were effective before
- If proposing the same improvement as before, state why different results are expected this time

**Update SALES_STRATEGY.md (targeting & KPI only) — premise first:**
The Target section is a hypothesis about who can use and buy the product — judge it by that, not by reply rate. It is failing when `not_relevant` rejecters or reply texts show senders who cannot use the product, when replies never become positive sentiment or inquiry outcomes, or when active strategies' `approach` does not select for the `Prerequisites`. Then fix upstream — rewrite Target (`Prerequisites`, `Not a fit`) and point discovery at sources where the Prerequisites are observable — before any messaging change; the stability discipline gates this too. Redefining the target within what the business sells is this skill's call; an audience beyond what the business serves is the user's — `record_suggestion` (`revisit-strategy`, below).
- Narrow or broaden targeting
- Update KPI goals

Do **not** edit messaging (subject line / body) or channel priority here — those are optimized deterministically by the daily lever tick (message-variant draw weights, channel affinity). Report their measured performance in Step 5; do not encode it as prose. (Tone/sub-channel preferences a user wrote in SALES_STRATEGY stay as their authored hints; evaluate just doesn't rewrite them.)

Save the updated document via `save_document` with `projectId: "$0"`, `slug: "sales_strategy"`, and the full markdown content.

**Update search keywords:**
- Add keywords related to high-response segments
- Remove ineffective keywords

**Update the discovery-strategy portfolio (registry, via `upsert_discovery_strategy`):**
Evaluate supplies and narrates this lever; the daily tick owns reply-based selection — it re-weights active strategies (Thompson draw weights in step 1's `get_lever_state` → `discovery.weights`) and archives dominated ones, never below two active. The current portfolio is `discovery.strategies`:
- **Demote**: archive a strategy (`archived: true`, resending its current `approach` unchanged) only on evidence the tick cannot see: a clearly elevated `bounceRate` (source finds unreachable people — wasteful and reputation-harming; bounces read earlier than replies), a source whose `approach` cannot select for the Target's `Prerequisites`, or a source that no longer exists or can no longer be searched. Reply-rate underperformance is the tick's call — narrate it, don't act on it
- **Promote / keep**: outperformers stay active (no write needed); cite the evidence in the report
- **Hypothesize**: when step 1's `get_lever_state` → `discovery.needsReplenishment` is true (active strategies below target, usually after the tick archived a loser), or the premise check reoriented the Target, register 1-2 new strategies — fresh slug + `approach` (where/how to search and why it should work, 2-5 lines) — derived from business / sales_strategy context and rejection feedback. New strategies start active with no history — that is the point: they need sends to become measurable. Hypothesize search/crawl strategies only — playbook-driven means need user setup; propose those via the suggestion block below. A refused upsert (400, active cap) means the portfolio is full — archive an underperformer first
- **Never reuse a slug for a different idea** — a slug is the arm's measured identity; archive instead. Refining the same idea may update the same slug's `approach`. Playbook-driven strategies get the same archive treatment; leave their `approach`'s playbook reference intact

**Suggest playbook-driven means (persist + report, never self-add):**
When a promising means needs user setup (platform account, login, ToS), don't register it as a strategy yourself — call `record_suggestion` with `projectId: "$0"`, `kind: "add-means"`, `dedupeKey` = tentative strategy slug, short `title`, `body` citing the evidence, and a `command` runnable verbatim like `/leadace <project> add <platform> as an outreach means` (working language is fine).
- Suggest only what the user alone can do — never what this skill or the loop can do itself.
- The server never resurrects a dismissed/done suggestion; if the confirmation says it was left untouched, drop it from next actions.
- add_means completion closes the suggestion automatically.

**Update the Learnings Log (the cross-stage self-improvement memory):**

The `learnings` document is the distilled, evidence-cited memory that build-list and outbound read each cycle — it is how a learning from one cycle re-enters every downstream stage automatically. Its honesty is enforced *here, at the write*.

Each entry is one line: `[stage] [YYYY-MM-DD] claim — evidence: metric=<name>, n=<sample>`. Stage tags, one per downstream decision a skill can act on:
- `[targeting]` — segments to collect / prioritize (read by build-list). Source: per-segment reply rates, `notRelevantNotes` targeting-mismatch clusters (the ≥2 rule from step 3).
- `[body]` — what responding messages do that non-responding ones don't (read by outbound, composition hint). Source: Message Analysis traits.
- `[timing]` — recontact-window / cadence patterns that converted (read by outbound). Source: priority / recontact data.
- `[channel]` — how to *use* a channel well (tone, opener), NOT which channel to pick (lever-owned). Read by outbound as color only.
- `[discovery]` — which discovery strategies / source types yield responsive *and reachable* prospects (read by build-list, strategy selection). Source: `discoveryStrategyResponseRate` per-slug reply rates AND bounceRate, fresh-signal split.

**Write gate — all required; a claim that can't meet these is a hunch, drop it:**
- `dataSufficiency.sufficient` is true and the stability discipline above says it is time to act.
- The entry cites a measured metric and its sample size, with `n ≥ minSamplePerArm` (from step 1's `get_lever_state`).
- The pattern repeated across cycles, not a one-off fluctuation.

**Reconcile before adding (the effect-measurement loop):**
- Re-check each existing entry's cited metric against this cycle. If its direction no longer reproduces, retire it: replace its leading tag with `[retired]`, keeping the rest of the line (`[retired] [YYYY-MM-DD] claim — evidence: …`). `[retired]` is a tombstone, not a stage tag — readers skip it; it stays only so a disproven claim isn't re-added. Cheap because the metric + n is already on the line.
- Keep ≤15 active (non-retired) entries; over the cap, retire weakest-evidence or oldest first.

Save the full list via `save_document` with `projectId: "$0"` and `slug: "learnings"`. When `dataSufficiency` is insufficient, do not write — an empty / unchanged log is the correct early state.

**Boundary:** learnings *steer* downstream LLM authoring and collection; they are never deterministic selectors and never edit SALES_STRATEGY messaging or channel priority (the levers own those). Frame each as "what the data shows."

**Replenish the message-angle pool (supply candidates, never pick winners):**
The lever tick prunes and re-weights message variants but never *generates* new ones. Close that gap here — supply, don't select:
- **When to act:** only when step 1's `get_lever_state` returns `needsReplenishment: true` — active variants below the target count (usually after the tick archived a loser), or a **stagnation rotation** freed a slot that is still unfilled: when every mature angle stays statistically indistinguishable for a sustained streak, the tick rotates out the weakest (`reason: "stagnation"` on the archived entry) so a fresh angle can break the plateau. If it is false, do nothing.
- **Guardrails:** the same gates as every change above — skip if `dataSufficiency` is insufficient, if the stability discipline says wait, or if a previously supplied variant has not yet matured (don't stack ungrown candidates). A stagnation rotation passes these by construction (every surviving arm is mature) — don't leave its slot unfilled.
- **What to produce:** read `list_message_variants` first (so you see the active and recently-archived angles), then add **exactly one** new angle that is *the most different from every active one* — a subject pattern (≤80 chars, only `{{org}}` / `{{name}}` / `{{signal}}` placeholders) plus a `bodyApproach` brief (2-5 lines: structure / tone / CTA type / length / opener policy), matching the SALES_STRATEGY voice, no fabricated company-specific claims. Micro-copy tweaks of an existing angle are not a new arm, and after a rotation, a re-phrasing of the rotated-out angle defeats the rotation's purpose — depart from the whole set. Upsert via `upsert_message_variant` with a fresh generation-namespaced slug — `[A-Za-z0-9_-]`, ≤32 chars (e.g. `gen_20260607`); never reuse an existing slug, active or archived (that overwrites the row). The server refuses (400) an upsert past the active cap — that means the pool isn't actually short; re-read `get_lever_state`.
- **Boundary (report-only intact):** this hands the bandit a new arm to *test* — it does not assert the new angle is better and does not edit SALES_STRATEGY messaging. Frame it as "an angle to test," not "a better message."

**Escalate a slump that messaging can't fix (suggest, never self-pivot):**
The loop's own escape hatch is the angle rotation above — use it, don't suggest it. But when the long-horizon signal says the problem is bigger than message angles — low performance **across every channel and every discovery strategy** persisting through repeated rotations and fresh angles — the remaining moves (repositioning, an audience beyond what the business serves, a full messaging reset) involve direction preferences only the user can set. Record that once via `record_suggestion`: `kind: "revisit-strategy"`, a stable `dedupeKey` naming the diagnosis (e.g. `cross-channel-slump`), `title` + `body` citing the measured evidence (per-channel and per-strategy rates, the rotation history), and a runnable `command` — `/leadace <project> refine strategy`, or `/leadace <project> reset messaging` when the evidence points at the message pool itself. Same rules as the add-means suggestions: dismissed/done is final, don't re-raise.

### 5. Results Report

Report the following directly to the user (no file output needed -- live metrics are in the Web UI `/evaluations`; this report is the narration):
- Key KPIs (response rate, positive rate, etc.)
- **Inquiry landing conversions** (from step 1's `inquiryOutcomeCounts`): show whenever any of `lead` / `signup_clicked` / `inquired` / `unsubscribed` is non-zero. Report `lead` (meeting-request conversions) and `signup_clicked` (self-serve signup conversions) separately — they reflect different CTA modes and inform whether the project's chosen CTA is converting. Skip the section when all five outcomes are 0
- Changes since the last cycle (what the Learnings Log added or `[retired]` in step 4, plus notable lever shifts from `get_lever_decisions`)
- **Discovery strategy performance** (from `discoveryStrategyResponseRate` / `freshSignalResponseRate`): per-strategy sends + reply rate, any registry changes applied in step 4 (archived / registered), and the with/without-signal split. Skip when no send carries a strategy slug yet
- **Suggestions recorded** (from step 4 — a new means to add, or a strategy revisit): title, one-line rationale, and the copy-runnable command; note it stays on the Web UI dashboard until acted on or dismissed. Skip when none
- Important findings from the analysis
- List of improvements applied
- **Tactical rejection signals** (from step 1's `get_rejection_feedback_summary`):
  - Tactical reason distribution (counts by `not_relevant` / `wrong_timing` / `budget` / `not_decision_maker` / `unsubscribe_request` / `other`). Show whenever tactical `total` > 0 — non-recontact reasons like `not_relevant` and `unsubscribe_request` still belong here
  - **Recontact queue** — for each non-empty bucket in `recontactWindows` (`never` / `3_months` / `6_months` / `12_months` / `unspecified`), report `count` and list the `samples` entries (organization, prospect name). State that time-bounded buckets are auto-deferred (`prospects.next_outreach_after` set on rejection) and will re-enter the outbound queue automatically once the window passes; `never` is a hard DNC opt-out, not a recontact. Omit this sub-bullet when every bucket has `count: 0`
  - **Decision-maker referrals** — list `decisionMakerPointers` rows (referring prospect → pointer name/email/role). State that auto-prospect-creation runs at record_response time (pointer with email creates a new prospect linked to the same projects; pointer with name only updates an existing same-org contact's role/department), so no manual registration is required. Omit this sub-bullet when `decisionMakerPointers` is empty
  - Skip the whole section only when tactical `total` is 0 (no tactical rejections at all)
- **Lever observability (apply + monitor)** (from step 1's `get_lever_state` / `get_lever_decisions`): make the automatic optimization visible so it is not a black box. Narrate:
  - **Message, channel & targeting levers (controlled)**: which message angles lead (draw weights, and `pBest` — the tick's probability each angle is best — when present) and their maturity (`total` vs `minSamplePerArm`), any recently archived variants (an entry with `reason: "stagnation"` was rotated out of an undifferentiated set to make room for a fresh angle — narrate it as a rotation for freshness, not a proven loser), the measured `channelAffinity` per coarse-industry bucket, and the `targetingLifts` axes (industry / size / country / discovery strategy / fresh signal — the measured multipliers behind the outbound ordering) — plus how these moved across the recent ticks (the decision history is the trend). If you supplied a fresh angle this run (pool replenishment), name it and say the tick will trend it. Say "uniform / none yet" when there isn't enough data
  - **Timing & priority (no control arm)**: applied and monitored, never A/B-tested or auto-reverted. Priority is an operator/LLM-supplied multiplier deliberately narrower than the measured lifts; surface its monitoring view — `priorityResponseRate` and the recontact / timing signals above — and call out notable shifts for the operator to judge. Per-prospect exceptions go through `set_prospect_priority` on explicit user request, not from this skill
  - Skip lines with no data yet (fresh project)
- Next actions to take (`/build-list` for additional exploration, `/outbound` for re-approach, etc.)
