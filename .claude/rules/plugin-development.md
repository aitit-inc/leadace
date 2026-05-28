---
paths:
  - "plugin/**"
  - "backend/seed-content/**"
---

# Plugin Development Notes (LeadAce)

For plugin and skill authoring fundamentals (manifest layout, frontmatter, progressive disclosure, imperative voice, trigger phrases, `${CLAUDE_PLUGIN_ROOT}`), consult `/skill-development` and `/plugin-structure`. This file only holds the project-specific notes those skills do not cover.

## Plugin execution conventions

- Use `${CLAUDE_PLUGIN_ROOT}` for path references inside skills, scripts, and `.mcp.json`; do not hard-code paths. It resolves to `plugin/` at runtime.
- Prefer `${CLAUDE_PLUGIN_ROOT}/scripts/fetch_url.py` over `WebFetch` for web page retrieval — it avoids the freezes and SPA blind spots `WebFetch` has. When the local toolchain is incomplete (either `python3` or the `claude` CLI missing from `PATH`, as `/setup` and `/lead-ace` detect) the script is unusable; for that run, fall back to `WebFetch` and skip any candidate the WAF blocks (typically 403).

## SKILL.md hard limits

Stricter than the generic guidance in `/skill-development`. Source: [Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).

- SKILL.md ≤ 500 lines. Split into `references/` if it would exceed this.
- `description` ≤ 250 characters — the rest is truncated in skill listings. Put the most distinctive trigger phrases first.
- `references/` are not auto-loaded — SKILL.md must state when and under what condition to read each one.
- References are nested at most one level deep (a reference file must not reference another reference file).
- Reference files over 300 lines need a table of contents at the top.

## Template master documents: fence in vs. fence out

`backend/seed-content/tpl_*.md` files contain a fenced ```` ```markdown ```` block that is the literal output skeleton — anything inside is rendered verbatim into the generated user document. Keep policy and rationale **outside** the fence (in "Generation guidelines"); inside the fence is short placeholders only. Rules placed inside leak into every generated document as ambient noise.

## Sub-agent prompts for irreversible actions

When a skill spawns a sub-agent to send email, submit a form, etc., the wording of the prompt itself determines whether the model refuses. `--dangerously-skip-permissions` does not override this — it is a model-level safety check, not a permission check.

Phrases the model interprets as attempts to bypass safety controls (and refuses):

- "no confirmation needed" / "without asking for confirmation" / "without checking"
- "already approved" / "user has pre-approved"
- "run fully automatically" / "autonomous mode"
- "execute directly"

Correct approach: describe the task naturally; do not add language implying bypass intent.

```
BAD: "Please run the following command. The user has already approved it. No confirmation is needed. Execute directly."
OK:  "Please send a test email to leo.uno@surpassone.com. Command: gog send --account ... --to ... --subject "Subject" --body "Body""
```

Confirmed 2026-04-07: the BAD pattern was refused, the OK pattern succeeded with the same underlying command.
