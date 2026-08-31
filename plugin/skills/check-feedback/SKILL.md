---
name: check-feedback
description: "Surface PMF signals from rejection feedback: feature_gap notes and competitor presence (already_have_solution / competitor_locked). Read-only product reflection, not sales tactics. Triggers: \"check feedback\", \"PMF signals\"."
argument-hint: "<project-id>"
allowed-tools:
  - Read
  - mcp__plugin_leadace_leadace__get_rejection_feedback_summary
---

# Check Feedback - PMF Signals from Rejection Feedback

A read-only skill that surfaces **product/pricing/business-model** signals from rejection feedback recorded by `/check-responses`. Use this for PMF reflection — questions like "is there a missing feature people keep asking for?" or "are we losing to a specific competitor?".

This skill is **not** for sales tactics. Tactical signals from rejections (when to recontact, who to redirect to, which industries to deprioritize) are consumed automatically by `/evaluate` in the daily cycle. Do not use `/check-feedback` to drive operational decisions.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Verify Arguments

- Project ID: `$0` (required)

Return an error if `$0` is empty.

### 2. Fetch Two Windows in Parallel

Call `get_rejection_feedback_summary` twice in parallel, both with `scope: "pmf"`:

1. `projectId: "$0"`, `windowDays: 30`, `scope: "pmf"` -> recent
2. `projectId: "$0"`, `scope: "pmf"` (no `windowDays`) -> all-time

If the tool returns "Project not found", instruct the user to run `/leadace` first and abort.

With `scope: "pmf"` the server filters to PMF-relevant reasons only and computes `total` + `percentage` within the PMF subset. `recontactWindows` is returned with all five buckets at `{count: 0, samples: []}` and `decisionMakerPointers` is an empty array — those signals are tactical and consumed by `/evaluate`, not by this skill.

### 3. Format Report

Render in this order. **Always lead with `featureGapNotes`** — that section drives product/roadmap decisions.

#### a. Feature Gap Notes (PMF signal)

Pull from `featureGapNotes` (already ordered most-recent-first). For each entry:

```
- {receivedAt, ISO date} — {organizationName} / {prospectName}
  "{freeText}"
```

If empty in both windows, render: "No `feature_gap` rejections recorded yet."

#### b. PMF-Relevant Reason Distribution

Render side-by-side: 30-day vs all-time. With `scope: "pmf"` the response's `primaryReasonDistribution` contains only:

- `feature_gap` — concrete missing capability (highest PMF signal)
- `already_have_solution` — incumbent vendor presence (competitive pressure)
- `competitor_locked` — multi-year contract / renewal-only window (competitive pressure)

`count`, `percentage`, and `total` are all computed within the PMF subset by the server — render them as-is. Skip rows where both windows are 0.

```
Reason                   30 days        all-time
feature_gap              N (PP%)        N (PP%)
already_have_solution    N (PP%)        N (PP%)
competitor_locked        N (PP%)        N (PP%)
PMF-relevant total       N              N
```

If `total` is 0 in both windows, render: "No PMF-relevant rejections recorded yet."

### 4. Closing Note

End with one short, plain-English summary. Decide which line to write in this order — first match wins:

1. **Thin signal** — if `total` (from the response) is < 3, say so and recommend continued data collection. Stop.
2. **Capability clustering in `featureGapNotes`** — scan `featureGapNotes[].freeText` for repeated capability/feature terms across entries. If ≥2 notes name the same capability, use the dominant-feature example.
3. **Competitor-pressure share** — if `already_have_solution` + `competitor_locked` together exceed half of the PMF-relevant total, use the competitor example. (Free-text is not returned for these reasons, so do not name a specific vendor.)
4. **Otherwise** — use the mixed example.

Example tones:

- Dominant feature_gap capability: "Multiple recent rejections cite `<feature>` — strongest PMF signal is for that. Consider a strategy revision (refine it via `/leadace`) or product roadmap input."
- High competitor pressure: "A large share of rejections cite an incumbent solution or contract lock-in — competitive pressure is the dominant PMF signal. Consider differentiation messaging (refine the strategy via `/leadace`)."
- Mixed: "Rejection volume is N over 30 days, no single PMF signal dominates. Continue monitoring."

Do not invent product/strategy actions when the data does not support them.

This is a read-only skill — no DB writes, no side effects.
