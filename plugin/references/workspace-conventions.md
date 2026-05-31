# Workspace Conventions

Common rules for all skills and sub-agents.

## Data Storage

All project data is stored on the server and accessed via MCP tools (`mcp__plugin_leadace_api__*`). There are no local project directories or databases.

- **Structured data** (prospects, outreach logs, responses, evaluations): Dedicated MCP tools (`add_prospects`, `record_outreach`, etc.)
- **Documents** (business info, sales strategy, search notes): `get_document` / `save_document` MCP tools with slugs: `business`, `sales_strategy`, `search_notes`
- **Master documents** (templates, guidelines, frameworks): `get_master_document` MCP tool with slugs like `tpl_business`, `tpl_email_guidelines`, etc. These are shared across all users and updated centrally
- **Local files**: Only plugin SKILL.md files, local-operation references (claude-in-chrome-guide, form-filling), and scripts in `${CLAUDE_PLUGIN_ROOT}/`

## Command Execution Rules

- **Do not use cd.** Run all bash commands from the workspace root.
- Local utility tools are in `${CLAUDE_PLUGIN_ROOT}/scripts/` (e.g., `fetch_url.py`).

## MCP Tool Error Handling

If any MCP tool call returns a "Project not found" error, instruct the user to run `/leadace` first and abort the current skill.

## Document Write Safeguard

When calling `save_document` (or any MCP tool that persists user-visible document/content), sanity-check that the content matches the slug's intent and the active project context. If the content is clearly unrelated — e.g., the session has drifted to another topic, the wrong project is selected, or stray output is about to be pasted in — confirm with the user before saving. Documents are persistent and read by other skills, so a wrong write is not silently absorbed.

## Explore wide, output narrow

When investigating, weighing options, or drafting internally, cast a wide net across angles. When producing output that a skill persists or reports back (documents, settings fields, evaluation records, search-notes, completion summaries), cut to the minimum that carries the conclusion — on fresh writes and revisions alike. "Just in case" and "might as well note this" filler doesn't get read, buries the important parts, and breeds inconsistency over time — pure cost, no upside.
