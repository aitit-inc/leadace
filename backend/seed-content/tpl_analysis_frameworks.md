# Analysis & Improvement Frameworks

A reference guide for improving analysis accuracy in /evaluate.

## Root Cause Analysis for Low Response Rates (6 Perspectives)

When response rates fall below expectations, examine the following 6 causes in order:

### 1. Subject Line Problem (Not Being Opened)
- Symptoms: Overall low engagement
- Owned by the lever (report-only): subject selection is a weighted draw across the seeded `subject_variants`; the bandit learns from replies. Report which variants underperform (`variantResponseRate` + the lever weights) — do not rewrite subjects. If every variant is weak, suggest the user seed fresher patterns (shorter, numbers, recipient's company name, curiosity-driven) via `upsert_subject_variant`

### 2. Targeting Problem (Wrong Audience)
- Symptoms: Zero responses despite high volume
- Remedies: Revisit target definition, analyze common traits among companies that did respond

### 3. Body Content Problem (Read but No Action)
- Symptoms: Some responses come in but positive rate is low
- Report-only: surface what correlates with positive replies (recipient-benefit-led framing, less self-promotion, specific numbers / case studies). Body copy is a user-authored SALES_STRATEGY hint — report the observation, do not rewrite it here

### 4. CTA Problem (Response Barrier Too High)
- Symptoms: Interest seems present but no replies
- Report-only: note lower-barrier CTA options ("30-minute meeting" → "15-minute information exchange", "Shall I send you materials?") as a suggestion for the user's SALES_STRATEGY; evaluate does not apply messaging edits

### 5. Timing Problem (Poor Send Time)
- Symptoms: Response rate skewed by day of week or time of day
- Remedies: Since sending timing is determined by the daily-cycle execution schedule (cron, etc.), do NOT write sending time constraints in SALES_STRATEGY.md. Instead, report in the report or "notes for next time" as a **recommendation** such as "Tue-Thu mornings tend to show higher response rates." Users adjust execution timing by modifying cron settings

### 6. Channel Problem (Other Channels More Effective)
- Symptoms: No response from email but responses from SNS (or vice versa)
- Owned by the lever (report-only): channel ranking is the affinity re-rank per coarse-industry. Report the measured `channelResponseRate` / `channelAffinity` and any shift — do not rewrite channel priority

## Message Pattern Analysis (no deterministic edits — narrate, and route repeated findings to the Learnings Log)

There is no manual A/B test to design or "adopt as default" here. Subject lines are optimized by the lever tick (the bandit's continuous weighted draw across `subject_variants`, learning from replies); channel ranking by the affinity re-rank. /evaluate reads their measured performance and narrates it — it does not run subject / channel experiments or write `ab_test` records.

For message elements no lever owns (body length, CTA phrasing, tone, hook), the structured home for a *repeated, number-anchored* finding is the Learnings Log: write it as a gated `[body]` / `[channel]` entry (per /evaluate SKILL.md step 4) so outbound applies it as a composition hint next cycle, instead of the observation evaporating into the report. Still narrate it in the report, and still do not rewrite SALES_STRATEGY messaging or encode it as a deterministic / evaluate-applied change — learnings steer authoring, they are not rules.

### Dimensions to compare when reporting
- **Subject patterns**: curiosity vs. number vs. problem-mention (from variant performance — lever-owned)
- **Body length**: short (~150 chars) vs. detailed (~300 chars)
- **CTA phrasing**: "meeting" vs. "information exchange" vs. "demo" vs. "send materials"
- **Tone**: formal vs. casual
- **Hook**: company-name mention vs. industry challenge vs. numbers / achievements

## Targeting Accuracy Verification

Once send data has accumulated, perform the following analyses:

### Analysis of Common Traits Among Responding Companies
- Industry, size, region, search keywords, priority score
- Traits common to responding companies but absent in non-responding companies

### Analysis of Common Traits Among Non-Responding Companies
- Traits common to companies with no response
- Identify segments to exclude

### Actions
- Update target definition in SALES_STRATEGY.md
- Add/remove search keywords
- Adjust priority scores (bulk update via `record_evaluation` MCP tool with `priorityUpdates`)
