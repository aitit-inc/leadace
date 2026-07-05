#!/usr/bin/env bash
# One-time interactive setup for the local E2E harness.
#
# Combines two operations into a single Claude session:
#   1. Anthropic subscription login (no-op if already logged in)
#   2. LeadAce MCP OAuth dance against the local MCP Worker
#
# Usage:
#   ./e2e/setup.sh
#
# Inside the resulting interactive Claude session:
#   /login                # if not logged in yet — sign in via browser
#   /leadace overview       # triggers the LeadAce MCP OAuth flow + lists projects
#     ★ Verify the printed URL is http://localhost:8788/authorize?...
#       NOT https://mcp.leadace.ai/authorize?... — the staged plugin pins
#       the URL to local; if you see the production host, abort and report.
#     Sign in with Google in your host browser, click Allow.
#     The browser is redirected to http://localhost:47291/callback?...
#     /leadace overview continues automatically and lists local projects (empty on
#     a fresh local DB).
#   /exit
#
# Re-run scenarios:
#   - First-ever setup: this script handles everything end-to-end.
#   - After `wrangler dev` restart (local MCP KV is in-memory and was lost):
#     re-run this script. /login will be a no-op; /leadace overview re-does the OAuth
#     dance only.
#
# State persists in $REPO_ROOT/e2e/.claude-state (gitignored), leaving the
# developer's host-side ~/.claude state untouched.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export CLAUDE_CONFIG_DIR="$REPO_ROOT/e2e/.claude-state"
mkdir -p "$CLAUDE_CONFIG_DIR"

# Pin the OAuth-callback port; unset, Claude Code picks an ephemeral port,
# which works but is harder to document (the header above names 47291).
export MCP_OAUTH_CALLBACK_PORT="${MCP_OAUTH_CALLBACK_PORT:-47291}"

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
  --chrome
