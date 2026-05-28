---
name: setup
description: "This skill should be used when the user asks to \"set up\", \"start\", \"initialize\", \"connect\", \"first time\", \"onboard\", or wants to start using LeadAce. Verifies the LeadAce connection (MCP, Gmail, local tools), lists or creates a project, and saves the environment status for downstream skills."
argument-hint: "[project-name]"
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
  - mcp__plugin_lead-ace_api__get_server_version
  - mcp__plugin_lead-ace_api__list_projects
  - mcp__plugin_lead-ace_api__setup_project
  - mcp__plugin_lead-ace_api__get_gmail_status
  - mcp__plugin_lead-ace_api__get_tenant_settings
  - mcp__plugin_lead-ace_api__update_tenant_settings
  - mcp__plugin_lead-ace_api__save_document
---

# Setup - First-time Onboarding & Environment Check

A skill that verifies all LeadAce connections (cloud MCP, Gmail SaaS, local tools), surfaces what is and is not available, picks or creates a project, and stores the environment status so that subsequent skills (`/strategy`, `/build-list`, `/outbound`, `/daily-cycle`, etc.) can rely on it without re-asking.

Run this skill the first time you use LeadAce, and re-run it whenever your local tools or Gmail connection status change.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Procedure

### 1. Run the shared environment-check procedure

`Read` `${CLAUDE_PLUGIN_ROOT}/references/onboarding/env_check.md` and execute its full procedure (Steps 1-5). Pass:
- `$0` (the project name argument from the user; may be empty)
- No `$URL` (this skill does not use URL-driven naming)

The shared procedure:
- Verifies MCP version + auth
- Detects Gmail SaaS, asks about Gmail MCP and Claude in Chrome
- Picks or creates the project
- Saves the `env_status` document

When the procedure finishes, you have `PROJECT_NAME` and a 4-line capability summary.

### 2. Completion Report

Print a short, scannable summary:
- Project in use (`PROJECT_NAME`)
- The capability table from the saved `env_status` doc
- An explicit list of any missing capabilities and what each blocks
- A one-line note that recipient delivery is **currently limited to US / CA / JP**
- Next step: "Run `/strategy PROJECT_NAME` to define your sales and marketing strategy."

If the Gmail SaaS connection was missing, surface that as the most prominent fix-it line, since it is the most common reason `/outbound` fails later.
