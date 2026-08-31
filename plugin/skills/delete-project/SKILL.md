---
name: delete-project
description: "This skill should be used when the user asks to \"delete a project\", \"remove a project\", or wants to permanently delete a registered project and all its data from the server."
argument-hint: "<project-id>"
allowed-tools:
  - Read
  - AskUserQuestion
  - mcp__plugin_leadace_leadace__delete_project
---

# Delete Project

A skill that permanently deletes a project and all its associated data (prospects, outreach logs, responses, documents) from the server.

**Before starting:** `Read` `${CLAUDE_PLUGIN_ROOT}/references/workspace-conventions.md` and follow the cross-cutting conventions there (data storage, MCP error handling, document writes, output discipline).

## Steps

### 1. Verify Arguments

- Project ID: `$0` (required)

Return an error if `$0` is empty.

### 2. Confirm Deletion

Use AskUserQuestion to ask: "Are you sure you want to delete project '$0' and ALL its data (prospects, outreach logs, responses, documents)? This cannot be undone."

If the user declines, abort.

### 3. Delete Project

Call `delete_project` with `projectId: "$0"`.

If the tool returns a "Project not found" error, report that the project does not exist and exit.

### 4. Completion Report

- Confirm project "$0" and all its data have been deleted
