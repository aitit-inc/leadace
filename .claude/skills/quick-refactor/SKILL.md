---
name: quick-refactor
description: "Cleanup pass right after implementing a change, before the PR. Triggers: 'quick refactor', 'quick-refactor', 'リファクタリング', 'refactor what we just did'. Forked Opus subagent at xhigh effort."
context: fork
model: opus
effort: xhigh
---

# Quick refactor

Cleanup of a change just implemented. Behaviour does not change.

## Scope

- Baseline: uncommitted changes (staged, unstaged, untracked). None → `git diff develop...HEAD`.
- `$ARGUMENTS`: file names narrow the baseline; a commit range or PR number replaces it.
- Read each hunk with enough context to know what it is for.

## Pass

Changed code only, in this order:

1. **Comments** — delete any that restate the code. Keep only a *why* the code cannot express, as short as possible.
2. **Waste** — remove what the change does not need. Aim for the smallest, most obvious implementation that meets the spec. Fewer lines is not the goal; no abstraction for its own sake.
3. **Symptomatic fixes** — a guard that patches one case → write the rule instead. Only while the edit stays inside the change; anything wider goes in the report.

Untouched: code the change did not introduce (mention it in the report).

## Verify and report

- Run the area's checks from CLAUDE.md (backend: `npm run typecheck`, `npm test`; frontend: `npm run check`). Changed SQL predicate → its `e2e/regression-*.sh` if the local stack is up.
- Do not commit, push, or merge.
- Report: what was removed or reshaped and why; what was left as out of scope; check output verbatim on failure.
