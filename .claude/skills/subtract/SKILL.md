---
name: subtract
description: "Subtraction pass on a change once its PR is open, before the Codex review: structure, optionality, comments and text the change does not need. Triggers: 'subtract', '引き算', 'quick refactor', 'リファクタリング', 'refactor what we just did'. Forked Opus subagent at high effort."
context: fork
model: opus
effort: high
---

# Subtract

A pass over a change whose PR is open, before the Codex review: take out what the change does not need. What the change does stays the same. An edit that would alter it, or that needs a migration or new screenshots to verify, is reported with its alternative, not applied.

## Scope

- Baseline: uncommitted changes (staged, unstaged, untracked). None → `git diff develop...HEAD`.
- `$ARGUMENTS`: file names narrow the baseline; a commit range or PR number replaces it.
- Read the PR body and its issue first: what the change is for decides what it needs.
- Read each hunk with enough context to know what it is for.

## Pass

Edit only what the change introduced and the existing code it copies or routes around. In this order:

1. **Structure** — every table, column, enum value, index, migration, stored or API shape, type, module and code path the change adds. What changes for the same reason lives in one place; what changes for different reasons stays apart, however alike it looks. So where the change stores or decides something the system already does, grow that place and remove the copy; a merge that has to branch on which caller it serves is two things forced into one. Fewer lines is a result, not the goal. A new main path is right when nothing existing fits.
2. **Optionality** — every null, undefined or optional field the change adds is a real, distinct state of the business logic, or it goes: a default, a split type, or nothing. `unknown` stays only where outside data enters and is narrowed; `any` never.
3. **Symptomatic fixes** — a guard that patches one case → write the rule instead.
4. **Comments** — delete by default. Keep one only for a *why* the code cannot carry, or where dropping it would invite the bug it prevents. As short as it can be.
5. **LLM-facing text** — prompts, skill / reference text, tool descriptions: shorten without changing meaning. No filler; plain words, short sentences.

## Verify and report

- Run the area's checks from CLAUDE.md (backend: `npm run typecheck`, `npm test`; frontend: `npm run check`). Changed SQL predicate → its `e2e/regression-*.sh` if the local stack is up.
- Do not commit, push, or merge.
- Report: each structure the change adds, removed or kept and why; what else was removed or reshaped and why; what was left as out of scope; check output verbatim on failure; last, one line for the PR body: what this pass removed, or that it removed nothing.

## Upkeep

If about ten PRs in a row remove nothing, shrink this pass.
