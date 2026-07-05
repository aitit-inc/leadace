#!/usr/bin/env bash
# Verify that the local stack the harness depends on is running.
#
# Usage:
#   ./e2e/preflight.sh
#
# Exit status:
#   0 — every check passed
#   1 — at least one service is unreachable; details on stderr

set -uo pipefail

fail() { echo "FAIL: $1" >&2; }
ok()   { echo "ok:   $1"; }

errors=0

check_url() {
  local label="$1" url="$2"
  if curl --silent --show-error --fail --max-time 5 "$url" > /dev/null 2>&1; then
    ok "$label ($url)"
  else
    fail "$label not reachable at $url"
    errors=$((errors + 1))
  fi
}

# Supabase Auth (54321) and Postgres (54322) are needed by the API + MCP
# Workers. Studio (54323) and Inbucket (54324) are nice-to-haves for
# debugging but not required by the harness, so we only check the two
# load-bearing endpoints.
check_url "Supabase Auth"     "http://localhost:54321/auth/v1/health"
check_url "API Worker"        "http://localhost:8787/health"
check_url "MCP Worker"        "http://localhost:8788/.well-known/oauth-authorization-server"
check_url "Frontend dev"      "http://localhost:5173"

if command -v claude > /dev/null 2>&1; then
  ok "claude CLI ($(claude --version 2>/dev/null | head -1))"
else
  fail "claude CLI not on PATH (install Claude Code from https://claude.com/claude-code)"
  errors=$((errors + 1))
fi

if [[ "$errors" -gt 0 ]]; then
  echo "" >&2
  echo "Preflight failed: $errors check(s) did not pass. See e2e/README.md for setup." >&2
  exit 1
fi

echo ""
echo "Preflight OK — local stack is ready."
