# Shared helpers for the local E2E harness.
# Sourced by login.sh / oauth.sh / run.sh.

# Build a staging copy of plugin/ at e2e/.plugin-staging/ with the LeadAce MCP
# server URL hardcoded to the local Worker.
#
# Why staging exists: Claude Code's plugin .mcp.json only substitutes
# ${user_config.KEY} references at load time — arbitrary ${ENV_VAR} forms
# (and the bash-style ${VAR:-default}) are NOT expanded, so the literal
# default in plugin/.mcp.json (https://mcp.leadace.ai/mcp) wins regardless of
# what we set in the shell. Staging sidesteps the issue: bash itself writes
# the URL into the staged file, and Claude reads a plain string.
#
# The function is idempotent — rsync --delete keeps the staging dir in lockstep
# with plugin/ on every invocation, then we overwrite the single .mcp.json.
build_plugin_staging() {
  local staging="$REPO_ROOT/e2e/.plugin-staging"
  mkdir -p "$staging"
  rsync -a --delete --exclude='.git' "$REPO_ROOT/plugin/" "$staging/"

  local mcp_url="${LEADACE_MCP_URL:-http://localhost:8788/mcp}"
  cat > "$staging/.mcp.json" <<EOF
{
  "api": {
    "type": "http",
    "url": "$mcp_url"
  }
}
EOF
  echo "$staging"
}
