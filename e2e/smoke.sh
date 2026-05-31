#!/usr/bin/env bash
# End-to-end smoke test for the /leadace onboarding chain against the local
# stack.
#
# Runs `/leadace <url>` headless, captures the JSON result, parses out the
# project id the chain just created, then deletes it via /delete-project so
# the local tenant returns to a clean state.
#
# Usage:
#   ./e2e/smoke.sh                         # defaults to https://example.com
#   ./e2e/smoke.sh https://leadace.ai      # custom URL
#   SKIP_CLEANUP=1 ./e2e/smoke.sh          # keep the artifact for manual inspection
#
# Exit status:
#   0  — both /leadace and the cleanup succeeded (or cleanup was skipped)
#   1  — /leadace failed (budget cap, tool error, schema mismatch, ...)
#   2  — /leadace succeeded but the project id could not be parsed
#   3  — /delete-project failed
#
# Pre-reqs (one-time, see e2e/README.md):
#   - Local stack running: supabase / api / mcp / frontend
#   - Google OAuth provider configured for local Supabase
#   - ./e2e/setup.sh has been run (Claude Code subscription login + LeadAce
#     MCP OAuth tokens persisted to $REPO_ROOT/e2e/.claude-state)

set -euo pipefail

URL="${1:-https://example.com}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"
OUTPUT_DIR="$(dirname "$0")/output"
RUN_SH="$(dirname "$0")/run.sh"

mkdir -p "$OUTPUT_DIR"

ts() { date +%s; }

LEAD_ACE_OUT="$OUTPUT_DIR/smoke-leadace-$(ts).json"
DELETE_OUT="$OUTPUT_DIR/smoke-cleanup-$(ts).json"

echo "==> Running /leadace $URL (output=$LEAD_ACE_OUT)" >&2

# Smoke prompt: pre-resolves every interactive Q&A so the chain runs to 4B-4
# unattended. The trailing PROJECT_ID marker makes the created project id
# trivially greppable from the JSON `.result` string.
"$RUN_SH" "/leadace $URL

Headless smoke test — no interactive Q&A is available. Run the onboarding chain end-to-end making sensible default choices: when env_check would normally ask, treat optional integrations as unsure/skip; when strategy_drafting needs sender details, use placeholder values; when overlap with existing config would normally ask for a merge decision, prefer create-new. Do not send any outreach. Goal: verify the full chain reaches the 4B-4 strategy summary without stopping to ask the user.

After the completion report, on a final line by itself, print exactly one of:
PROJECT_ID=<the id of the project you just created>
PROJECT_ID=NONE   (only if you could NOT create a project — e.g. a hard blocker such as the LeadAce MCP server needing authorization). Never fabricate an id." \
  > "$LEAD_ACE_OUT"

if ! jq -e 'select(.is_error == false and .subtype == "success")' "$LEAD_ACE_OUT" > /dev/null; then
  echo "ERROR: /leadace did not complete cleanly. See $LEAD_ACE_OUT" >&2
  jq -r '.subtype, .errors? // empty, .result' "$LEAD_ACE_OUT" >&2 || true
  exit 1
fi

PROJECT_ID="$(jq -r '.result' "$LEAD_ACE_OUT" | grep -oE 'PROJECT_ID=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: could not parse PROJECT_ID from /leadace result. See $LEAD_ACE_OUT" >&2
  exit 2
fi

# A real project id is a nanoid. The chain prints PROJECT_ID=NONE (or a NONE_*
# variant) when it could NOT create one — most often because the LeadAce MCP
# server needs (re-)authorization after a `wrangler dev` restart wiped the
# in-memory KV. Without this guard the NONE sentinel parses as a "valid" id,
# cleanup runs against a bogus target, and the run reports a false PASS.
if [[ "$PROJECT_ID" == NONE* ]]; then
  echo "ERROR: /leadace did not create a project (PROJECT_ID=$PROJECT_ID)." >&2
  echo "       Most likely the LeadAce MCP server needs authorization — re-run ./e2e/setup.sh, then retry." >&2
  exit 1
fi

echo "==> /leadace OK, created project: $PROJECT_ID" >&2

if [[ "$SKIP_CLEANUP" == "1" ]]; then
  echo "==> SKIP_CLEANUP=1, leaving project (delete manually: ./e2e/run.sh \"/delete-project $PROJECT_ID ...\")" >&2
  exit 0
fi

echo "==> Cleaning up project $PROJECT_ID (output=$DELETE_OUT)" >&2

"$RUN_SH" "/delete-project $PROJECT_ID

Headless smoke-test cleanup, no interactive Q&A is available. This project was created moments ago in the same smoke run by /leadace $URL with placeholder sender values, outboundMode=draft, no outreach sent. The smoke test already verified the chain — deleting now to leave the tenant clean. The skill's confirmation step would normally ask Y/N — given the context above, treat the answer as Y and proceed to mcp__plugin_leadace_api__delete_project." \
  > "$DELETE_OUT"

if ! jq -e 'select(.is_error == false and .subtype == "success")' "$DELETE_OUT" > /dev/null; then
  echo "ERROR: /delete-project failed for $PROJECT_ID. See $DELETE_OUT" >&2
  jq -r '.subtype, .errors? // empty, .result' "$DELETE_OUT" >&2 || true
  exit 3
fi

echo "==> Cleanup OK. Smoke test PASS." >&2
