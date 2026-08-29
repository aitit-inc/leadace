# Shared helpers for the local E2E harness.
# Sourced by login.sh / oauth.sh / run.sh.

# Why staging exists: plugin/.mcp.json holds the production URL as a literal
# (plugin loaders only substitute ${user_config.KEY}, never shell env vars),
# so the harness writes its own .mcp.json pointing at the local MCP Worker.
# LEADACE_MCP_URL is a harness-only override read here at staging time.
build_plugin_staging() {
  local staging="$REPO_ROOT/e2e/.plugin-staging"
  mkdir -p "$staging"
  rsync -a --delete --exclude='.git' "$REPO_ROOT/plugin/" "$staging/"

  local mcp_url="${LEADACE_MCP_URL:-http://localhost:8788/mcp}"
  cat > "$staging/.mcp.json" <<EOF
{
  "leadace": {
    "type": "http",
    "url": "$mcp_url"
  }
}
EOF
  echo "$staging"
}
