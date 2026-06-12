#!/usr/bin/env bash
# Regression for server-side project-ref resolution (name-or-id, introduced
# when the MCP worker's resolveProjectId round-trip was removed). Every
# project-scoped endpoint accepts a project NAME or ID; resolveProject
# (services/projects.ts) resolves it with id-match precedence. If resolution
# regresses, every MCP tool that passes a project name breaks at once.
#
# Covers, against the local stack (localhost:8787 API + 54322 Postgres):
#
#   1. GET /projects/:ref/settings with the project NAME (incl. space,
#      URL-encoded) → 200, returns the project's settings row
#   2. Same endpoint with the project ID → 200 (id path unchanged)
#   3. Same endpoint with a bogus name → 404 Project "<ref>" not found
#   4. Body-embedded ref: POST /prospects/check-dedup with projectId=<name>
#      → 200; with a bogus name → 404
#   5. DELETE /projects/:ref by NAME → 200 and the row is gone
#
# Curl-only, no Claude session. Cleans up (the suite's own project only).
#
# Usage:
#   ./e2e/regression-project-ref.sh
#   SKIP_CLEANUP=1 ./e2e/regression-project-ref.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-projref-$(date +%s)"
PROJECT_NAME="$RUN_TAG project ref"

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

# HTTP status on stdout; response body written to the fixed temp file $API_OUT.
API_OUT=""
api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}
api_body() { cat "$API_OUT"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
uriencode() { jq -rn --arg v "$1" '$v|@uri'; }

require_jq
API_OUT="$(mktemp)"
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

cleanup_and_exit() {
  local rc=$?
  rm -f "${API_OUT:-}" 2>/dev/null || true
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project ${PROJECT_ID:-<none>} as-is." >&2
    exit "$rc"
  fi
  if [[ -n "${PROJECT_ID:-}" && "${PROJECT_DELETED:-0}" != "1" ]]; then
    echo "" >&2; echo "=== teardown ===" >&2
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN" "$API_URL/api/projects/$PROJECT_ID" || true
  fi
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
PROJECT_DELETED=0
say "project_id=$PROJECT_ID"

NAME_ENC="$(uriencode "$PROJECT_NAME")"
BOGUS_ENC="$(uriencode "$RUN_TAG no such project")"

step "1. path ref by NAME"
STATUS="$(api_status GET "/api/projects/$NAME_ENC/settings")"
assert_eq "GET settings by name → 200" "$STATUS" "200"
assert_eq "settings row is for the resolved project" "$(api_body | jq -r .projectId)" "$PROJECT_ID"

step "2. path ref by ID"
STATUS="$(api_status GET "/api/projects/$PROJECT_ID/settings")"
assert_eq "GET settings by id → 200" "$STATUS" "200"

step "3. path ref bogus name"
STATUS="$(api_status GET "/api/projects/$BOGUS_ENC/settings")"
assert_eq "GET settings by bogus name → 404" "$STATUS" "404"

step "4. body-embedded ref (check-dedup)"
DEDUP_BODY="$(jq -nc --arg pid "$PROJECT_NAME" --arg d "$RUN_TAG.example" \
  '{projectId:$pid, candidates:[{organizationDomain:$d}]}')"
STATUS="$(api_status POST /api/prospects/check-dedup "$DEDUP_BODY")"
assert_eq "check-dedup with projectId=name → 200" "$STATUS" "200"
DEDUP_BOGUS="$(jq -nc --arg pid "$RUN_TAG no such project" --arg d "$RUN_TAG.example" \
  '{projectId:$pid, candidates:[{organizationDomain:$d}]}')"
STATUS="$(api_status POST /api/prospects/check-dedup "$DEDUP_BOGUS")"
assert_eq "check-dedup with bogus projectId → 404" "$STATUS" "404"

step "5. DELETE by NAME"
STATUS="$(api_status DELETE "/api/projects/$NAME_ENC")"
assert_eq "DELETE project by name → 200" "$STATUS" "200"
if [[ "$STATUS" == "200" ]]; then PROJECT_DELETED=1; fi
STATUS="$(api_status GET "/api/projects/$NAME_ENC/settings")"
assert_eq "settings after delete → 404" "$STATUS" "404"

printf '\n=============== summary ===============\n' >&2
printf '  pass: %d, fail: %d\n' "$PASS" "$FAIL" >&2
[[ "$FAIL" -eq 0 ]] || exit 2
exit 0
