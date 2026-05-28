---
name: strategy
description: "This skill should be used when the user asks to \"formulate a strategy\", \"create a sales plan\", \"summarize business info\", \"generate SALES_STRATEGY.md\", \"review strategy\", \"update strategy\", or wants to create/update sales and marketing strategy. Interactively collects business information and auto-generates or updates BUSINESS.md and SALES_STRATEGY.md."
argument-hint: "<project-id>"
allowed-tools:
  - Bash
  - Read
  - WebSearch
  - WebFetch
  - AskUserQuestion
  - mcp__plugin_lead-ace_api__list_projects
  - mcp__plugin_lead-ace_api__get_evaluation_history
  - mcp__plugin_lead-ace_api__get_document
  - mcp__plugin_lead-ace_api__save_document
  - mcp__plugin_lead-ace_api__list_documents
  - mcp__plugin_lead-ace_api__get_master_document
  - mcp__plugin_lead-ace_api__get_project_settings
  - mcp__plugin_lead-ace_api__update_project_settings
  - mcp__plugin_lead-ace_api__get_tenant_settings
  - mcp__plugin_lead-ace_api__list_subject_variants
  - mcp__plugin_lead-ace_api__upsert_subject_variant
---

# Strategy - Sales & Marketing Strategy Development

A skill that collects business and service information from the user and generates or updates strategy documents. For the first run, all information is collected interactively; for subsequent runs, gap analysis is performed on existing content to supplement only what is missing.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Procedure

### 1. Run the shared strategy-drafting procedure (Mode A)

`Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/strategy_drafting.md` and execute its full procedure (Steps 1-8) using **Mode A (Interactive Q&A)**. Pass:
- `$0` (the project id, required)
- No `$URL`

Mode A behaves as follows (full detail in the reference):
- **Initial sub-mode** (no existing docs): Step 4-0 first asks once whether the user has a homepage URL or supporting materials (brochure / pitch deck / etc.). If yes, the run delegates to URL-driven inference (§4B-1..§4B-4); otherwise it walks 4-1..4-11 interactively. Step 4-11 (inquiry landing optional polish — video / PDF / brand color / logo / CTA: scheduling URL **or** SaaS sign up URL) is collected once in either path.
- **Update sub-mode** (existing docs): perform gap analysis, classify sections (not set / evaluate-managed / static), report state to the user, confirm policy (fill missing / specific / pivot), execute only the relevant 4-x steps. (4-0 is initial-only and skipped here.)

The reference handles:
- Sender-info migration check (legacy SALES_STRATEGY.md → project settings)
- Template-update detection (sections newly added in `tpl_sales_strategy`)
- Reference to other projects' strategies for 2nd-and-later project creation
- Auto-resolution of scheduling-service notification domains via `ref_scheduling_services`
- Project-settings persistence (sender display name + email, outbound mode)

### 2. Completion Report

- **Initial sub-mode**: Report an overview of the 2 generated documents and the `inquiry_chat_brief` save status (the AI inquiry chat goes live once the brief is saved, provided `inquiry_landing_enabled` is true — the default). Guide the user to run `/build-list` (or `/daily-cycle`) as the next step.
- **Update sub-mode**: Report a summary of what was updated. List updated and added sections in bullets.
