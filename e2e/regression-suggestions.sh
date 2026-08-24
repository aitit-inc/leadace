#!/usr/bin/env bash
# Regression for the suggestions surface (AI proposals persisted for the Web
# UI): record upsert semantics, user-owned status, and the playbook auto-done
# hook. If the dedupe/status rules regress, daily re-proposals either pile up
# duplicates or resurrect suggestions the user dismissed.
#
# Covers, against the local stack (localhost:8787 API):
#
#   1. POST /projects/:id/suggestions creates (written=true, status=open).
#   2. Re-POST with the same kind+dedupeKey refreshes the open row in place
#      (same id, updated title, still exactly one row).
#   3. PATCH /suggestions/:id status=dismissed wins: re-POST is a no-op
#      (written=false, status=dismissed, content untouched), and the open
#      filter excludes the row.
#   4. A browser save of a playbook_<slug> document (approved on write)
#      auto-resolves the matching open add-means suggestion to done; other
#      suggestions stay untouched. (The pending MCP-save case is covered by
#      regression-caller-gates.sh step 6.)
#   5. Re-POST after done is also a no-op (written=false, status=done).
#   6. A non-playbook document save touches no suggestion.
#   7. Validation: non-kebab kind → 400, bad status → 400, unknown id → 404.
#
# Curl-only, no Claude session. Cleans up (project delete cascades).
#
# Usage:
#   ./e2e/regression-suggestions.sh
#   SKIP_CLEANUP=1 ./e2e/regression-suggestions.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-suggestions-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
SLUG_A="upwork-web-dev"
SLUG_B="kaggle-competitions"

PASS=0
FAIL=0

step() { printf '\n=== %s ===\n' "$1" >&2; }
say()  { printf '  %s\n' "$1" >&2; }

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok  %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       want: %s\n       got:  %s\n' "$label" "$expected" "$actual" >&2; FAIL=$((FAIL + 1))
  fi
}

BODY_FILE="$(mktemp)"
api_status() { # method path [body] → HTTP status; response body in $BODY_FILE
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$body" "$API_URL$path"
  else
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}
api_body() { cat "$BODY_FILE"; }

suggestion_body() { # dedupeKey title
  jq -nc --arg k "$1" --arg t "$2" \
    '{kind:"add-means", dedupeKey:$k, title:$t,
      body:"Evidence: e2e probe body", command:("/leadace p add "+$k+" as an outreach means")}'
}

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }

require_jq
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

PROJECT_ID=""
cleanup_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} as-is." >&2
    exit "$rc"
  fi
  if [[ -n "$PROJECT_ID" ]]; then
    echo "" >&2; echo "=== teardown ===" >&2
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$API_URL/api/projects/$PROJECT_ID" || true
  fi
  rm -f "$BODY_FILE"
  exit "$rc"
}
trap cleanup_and_exit EXIT

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

step "setup: create project named \"$PROJECT_NAME\""
STATUS="$(api_status POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
[[ "$STATUS" == "201" ]] || { echo "project create failed ($STATUS): $(api_body)" >&2; exit 1; }
PROJECT_ID="$(api_body | jq -r .id)"
say "project_id=$PROJECT_ID"

step "1. record creates an open suggestion"
STATUS="$(api_status POST "/api/projects/$PROJECT_ID/suggestions" "$(suggestion_body "$SLUG_A" 'Try Upwork')")"
assert_eq "POST → 201" "$STATUS" "201"
SID1="$(api_body | jq -r '.id')"
assert_eq "written=true" "$(api_body | jq -r '.written')" "true"
assert_eq "status=open"  "$(api_body | jq -r '.status')" "open"

step "2. re-record refreshes the open row in place"
STATUS="$(api_status POST "/api/projects/$PROJECT_ID/suggestions" "$(suggestion_body "$SLUG_A" 'Try Upwork (updated)')")"
assert_eq "POST → 201" "$STATUS" "201"
assert_eq "written=true" "$(api_body | jq -r '.written')" "true"
assert_eq "same id (no duplicate row)" "$(api_body | jq -r '.id')" "$SID1"
api_status GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "exactly one row for the key" "$(api_body | jq -r --arg k "$SLUG_A" '[.suggestions[] | select(.dedupeKey == $k)] | length')" "1"
assert_eq "title refreshed" "$(api_body | jq -r --arg k "$SLUG_A" '.suggestions[] | select(.dedupeKey == $k) | .title')" "Try Upwork (updated)"

step "3. dismissed wins over a re-proposal"
STATUS="$(api_status PATCH "/api/suggestions/$SID1" '{"status":"dismissed"}')"
assert_eq "PATCH → 200" "$STATUS" "200"
assert_eq "status=dismissed" "$(api_body | jq -r '.status')" "dismissed"
STATUS="$(api_status POST "/api/projects/$PROJECT_ID/suggestions" "$(suggestion_body "$SLUG_A" 'Try Upwork (re-proposed)')")"
assert_eq "re-POST → 201" "$STATUS" "201"
assert_eq "written=false" "$(api_body | jq -r '.written')" "false"
assert_eq "reported status=dismissed" "$(api_body | jq -r '.status')" "dismissed"
api_status GET "/api/projects/$PROJECT_ID/suggestions?status=open" > /dev/null
assert_eq "open filter excludes it" "$(api_body | jq -r '.suggestions | length')" "0"
api_status GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "content untouched by blocked re-record" "$(api_body | jq -r --arg k "$SLUG_A" '.suggestions[] | select(.dedupeKey == $k) | .title')" "Try Upwork (updated)"

step "4. playbook save auto-resolves the matching add-means suggestion"
api_status POST "/api/projects/$PROJECT_ID/suggestions" "$(suggestion_body "$SLUG_B" 'Try Kaggle')" > /dev/null
SID2="$(api_body | jq -r '.id')"
STATUS="$(api_status PUT "/api/projects/$PROJECT_ID/documents/playbook_$SLUG_B" '{"content":"# Playbook\ne2e probe"}')"
assert_eq "playbook PUT → 201" "$STATUS" "201"
api_status GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "matching suggestion → done" "$(api_body | jq -r --argjson i "$SID2" '.suggestions[] | select(.id == $i) | .status')" "done"
assert_eq "other suggestion untouched" "$(api_body | jq -r --argjson i "$SID1" '.suggestions[] | select(.id == $i) | .status')" "dismissed"

step "5. re-record after done is a no-op"
api_status POST "/api/projects/$PROJECT_ID/suggestions" "$(suggestion_body "$SLUG_B" 'Try Kaggle again')" > /dev/null
assert_eq "written=false" "$(api_body | jq -r '.written')" "false"
assert_eq "reported status=done" "$(api_body | jq -r '.status')" "done"

step "6. non-playbook document save touches no suggestion"
api_status PUT "/api/projects/$PROJECT_ID/documents/sales_strategy" '{"content":"# Strategy\ne2e probe"}' > /dev/null
api_status GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "statuses unchanged" "$(api_body | jq -r '[.suggestions[].status] | sort | join(",")')" "dismissed,done"

step "7. validation"
STATUS="$(api_status POST "/api/projects/$PROJECT_ID/suggestions" \
  "$(jq -nc '{kind:"Add_Means", dedupeKey:"x", title:"t", body:"b", command:"c"}')")"
assert_eq "non-kebab kind → 400" "$STATUS" "400"
STATUS="$(api_status PATCH "/api/suggestions/$SID1" '{"status":"open"}')"
assert_eq "re-open rejected → 400 (PATCH is dismiss-only)" "$STATUS" "400"
STATUS="$(api_status PATCH "/api/suggestions/999999999" '{"status":"dismissed"}')"
assert_eq "unknown id → 404" "$STATUS" "404"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
