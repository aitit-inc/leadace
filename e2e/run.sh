#!/usr/bin/env bash
# Run an arbitrary `/<skill>` invocation through the local E2E harness.
#
# Usage:
#   ./e2e/run.sh "/leadace https://example.com"
#   ./e2e/run.sh "/build-list <project-id>"
#
# Pre-reqs (one-time, see e2e/README.md):
#   1. Local stack running on the host:
#      - npx supabase start
#      - cd backend && npm run dev:api / npm run dev:mcp
#      - cd frontend && npm run dev
#      - Google OAuth provider configured for local Supabase
#   2. Harness initialized: ./e2e/setup.sh (subscription login + MCP OAuth)

set -euo pipefail

PROMPT="${1:?usage: $0 \"<claude prompt>\"}"
MAX_BUDGET_USD="${MAX_BUDGET_USD:-1.50}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Isolate the harness's Claude state from the developer's host-side state.
# Login credentials, MCP refresh tokens, and history all live under here.
export CLAUDE_CONFIG_DIR="$REPO_ROOT/e2e/.claude-state"
mkdir -p "$CLAUDE_CONFIG_DIR" "$REPO_ROOT/e2e/output"

# Build the local-MCP plugin staging dir. See e2e/_lib.sh for the why.
# shellcheck source=./_lib.sh
. "$REPO_ROOT/e2e/_lib.sh"
PLUGIN_DIR="$(build_plugin_staging)"

cd "$REPO_ROOT"

exec claude \
  --plugin-dir "$PLUGIN_DIR" \
  --add-dir "$REPO_ROOT" \
  --settings "$REPO_ROOT/e2e/settings.json" \
  --setting-sources user \
  --permission-mode dontAsk \
  --chrome \
  --max-budget-usd "$MAX_BUDGET_USD" \
  --output-format json \
  --no-session-persistence \
  --print \
  "$PROMPT"
