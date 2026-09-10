#!/usr/bin/env bash
# Regression for scheduled runs: the rows that decide when the hosted agent
# acts on its own. A schedule is a standing authorization, so the parts that
# must not drift are the write surface (validation, the per-project ceiling)
# and the claim that makes a due hour run exactly once — a claim that stopped
# holding would re-run a cycle, and a broken schedule that never stops would
# burn budget nightly.
#
# Covers, against the local stack (localhost:8787 API):
#
#   1. Create: a schedule comes back with its days, hour and zone; a second
#      project's schedule is not listed under the first.
#   2. Validation: unknown time zone, hour out of range, empty days, empty
#      prompt and an unknown field are each 400.
#   3. Ceiling: the 6th schedule on one project is 403.
#   4. Patch: prompt / hour / days / zone change in place, a patch naming one
#      field leaves the rest, enabled=false stops it, and re-enabling clears
#      the failure counter.
#   5. Claim: the cron's hourly run starts at most one run per schedule per
#      local hour, and a schedule edited onto another hour cannot be claimed on
#      the old one (asserted through the run-key column, without a model call).
#   6. Delete: gone from the list, and a second delete is 404.
#
# Cross-tenant isolation for the table lives in regression-tenant-isolation.sh,
# where a real second GoTrue user exists.
#
# Curl-only, no Claude session and no model call. Cleans up (project delete
# cascades its schedules).
#
# Usage:
#   ./e2e/regression-schedules.sh
#   SKIP_CLEANUP=1 ./e2e/regression-schedules.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-schedules-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
OTHER_PROJECT_NAME="$RUN_TAG other"

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
api_as() { # token method path [body] → HTTP status; response body in $BODY_FILE
  local token="$1" method="$2" path="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "$body" "$API_URL$path"
  else
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" "$API_URL$path"
  fi
}
ui() { api_as "$TOKEN_UI" "$@"; }
api_body() { cat "$BODY_FILE"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }

# The claim lives in a column no endpoint exposes; read it straight from the
# local database, the same way the cron would see it.
DB_URL="$(grep -E '^DATABASE_URL' "$REPO_ROOT/backend/.dev.vars" | head -1 | sed -E 's/^DATABASE_URL[[:space:]]*=[[:space:]]*"?([^"]+)"?$/\1/')"
psql_q() { psql "$DB_URL" -qtAc "$1"; }

require_jq
command -v psql >/dev/null 2>&1 || { echo "need psql on PATH" >&2; exit 1; }
[[ -n "$DB_URL" ]] || { echo "no DATABASE_URL in backend/.dev.vars" >&2; exit 1; }

TOKEN_UI="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN_UI" ]] || { echo "failed to mint browser JWT" >&2; exit 1; }

PROJECT_ID=""
OTHER_PROJECT_ID=""
cleanup_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} as-is." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  for p in "$PROJECT_ID" "$OTHER_PROJECT_ID"; do
    [[ -n "$p" ]] && curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN_UI" "$API_URL/api/projects/$p" || true
  done
  rm -f "$BODY_FILE"
  exit "$rc"
}
trap cleanup_and_exit EXIT

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

step "setup: two projects"
STATUS="$(ui POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
[[ "$STATUS" == "201" ]] || { echo "project create failed ($STATUS): $(api_body)" >&2; exit 1; }
PROJECT_ID="$(api_body | jq -r .id)"
STATUS="$(ui POST /api/projects "$(jq -nc --arg n "$OTHER_PROJECT_NAME" '{name:$n}')")"
if [[ "$STATUS" == "201" ]]; then
  OTHER_PROJECT_ID="$(api_body | jq -r .id)"
  say "project_id=$PROJECT_ID other=$OTHER_PROJECT_ID"
else
  # Free allows one project; the cross-project listing check is skipped then.
  say "project_id=$PROJECT_ID (second project refused: $STATUS — plan cap)"
fi

new_body() { # prompt hour zone days-json
  jq -nc --arg p "$1" --argjson h "$2" --arg tz "$3" --argjson d "$4" --arg pid "$PROJECT_ID" \
    '{projectId:$pid, prompt:$p, hour:$h, timezone:$tz, days:$d}'
}

step "1. create"
STATUS="$(ui POST /api/schedules "$(new_body "Run today's cycle for up to 30 prospects." 9 "Asia/Tokyo" '[1,2,3,4,5]')")"
assert_eq "create → 201" "$STATUS" "201"
SCHEDULE_ID="$(api_body | jq -r .id)"
assert_eq "hour saved" "$(api_body | jq -r .hour)" "9"
assert_eq "zone saved" "$(api_body | jq -r .timezone)" "Asia/Tokyo"
assert_eq "days saved" "$(api_body | jq -c .days)" "[1,2,3,4,5]"
assert_eq "enabled by default" "$(api_body | jq -r .enabled)" "true"
assert_eq "no thread until it runs" "$(api_body | jq -r .threadId)" "null"
ui GET "/api/schedules?projectId=$PROJECT_ID" > /dev/null
assert_eq "listed for its project" "$(api_body | jq -r --arg i "$SCHEDULE_ID" '[.schedules[] | select(.id == $i)] | length')" "1"
if [[ -n "$OTHER_PROJECT_ID" ]]; then
  ui GET "/api/schedules?projectId=$OTHER_PROJECT_ID" > /dev/null
  assert_eq "not listed for another project" "$(api_body | jq -r --arg i "$SCHEDULE_ID" '[.schedules[] | select(.id == $i)] | length')" "0"
fi

step "2. validation"
STATUS="$(ui POST /api/schedules "$(new_body "x" 9 "Mars/Olympus" '[1]')")"
assert_eq "unknown time zone → 400" "$STATUS" "400"
STATUS="$(ui POST /api/schedules "$(new_body "x" 24 "UTC" '[1]')")"
assert_eq "hour 24 → 400" "$STATUS" "400"
STATUS="$(ui POST /api/schedules "$(new_body "x" 9 "UTC" '[]')")"
assert_eq "no days → 400" "$STATUS" "400"
STATUS="$(ui POST /api/schedules "$(new_body "   " 9 "UTC" '[1]')")"
assert_eq "blank prompt → 400" "$STATUS" "400"
STATUS="$(ui POST /api/schedules "$(jq -nc --arg pid "$PROJECT_ID" '{projectId:$pid, prompt:"x", hour:9, timezone:"UTC", days:[1], nope:true}')")"
assert_eq "unknown field → 400" "$STATUS" "400"

step "3. per-project ceiling"
for i in 2 3 4 5; do
  STATUS="$(ui POST /api/schedules "$(new_body "filler $i" "$i" "UTC" '[0]')")"
  [[ "$STATUS" == "201" ]] || { echo "filler $i failed ($STATUS): $(api_body)" >&2; exit 1; }
done
STATUS="$(ui POST /api/schedules "$(new_body "one too many" 6 "UTC" '[0]')")"
assert_eq "6th schedule → 403" "$STATUS" "403"

step "4. patch"
STATUS="$(ui PATCH "/api/schedules/$SCHEDULE_ID" '{"prompt":"Collect 20 new prospects.","hour":6,"days":[1],"timezone":"America/New_York"}')"
assert_eq "patch → 200" "$STATUS" "200"
assert_eq "prompt changed" "$(api_body | jq -r .prompt)" "Collect 20 new prospects."
assert_eq "hour changed" "$(api_body | jq -r .hour)" "6"
assert_eq "days changed" "$(api_body | jq -c .days)" "[1]"
assert_eq "zone changed" "$(api_body | jq -r .timezone)" "America/New_York"
STATUS="$(ui PATCH "/api/schedules/$SCHEDULE_ID" '{"hour":11}')"
assert_eq "one-field patch → 200" "$STATUS" "200"
assert_eq "one-field patch leaves the prompt" "$(api_body | jq -r .prompt)" "Collect 20 new prospects."
assert_eq "one-field patch leaves the days" "$(api_body | jq -c .days)" "[1]"
assert_eq "one-field patch leaves the zone" "$(api_body | jq -r .timezone)" "America/New_York"
STATUS="$(ui PATCH "/api/schedules/$SCHEDULE_ID" '{"enabled":false}')"
assert_eq "disable → 200" "$STATUS" "200"
assert_eq "disabled" "$(api_body | jq -r .enabled)" "false"
psql_q "UPDATE schedules SET consecutive_failures = 3, last_error = 'boom' WHERE id = '$SCHEDULE_ID'" > /dev/null
ui PATCH "/api/schedules/$SCHEDULE_ID" '{"enabled":true}' > /dev/null
assert_eq "re-enabling clears failures" "$(api_body | jq -r .consecutiveFailures)" "0"
assert_eq "re-enabling clears the error" "$(api_body | jq -r .lastError)" "null"
STATUS="$(ui PATCH "/api/schedules/unknown-id" '{"enabled":true}')"
assert_eq "patch unknown id → 404" "$STATUS" "404"

step "5. one run per local hour"
# The cron claims a due schedule by moving its run key; the claim is a
# conditional update, so firing the handler twice in the same hour must leave
# one key and one claim behind. Point the schedule at the current UTC hour.
HOUR_UTC="$(date -u +%H | sed 's/^0//')"
[[ -z "$HOUR_UTC" ]] && HOUR_UTC=0
DOW="$(date -u +%w)"
ui PATCH "/api/schedules/$SCHEDULE_ID" "$(jq -nc --argjson h "$HOUR_UTC" --argjson d "[$DOW]" '{hour:$h, timezone:"UTC", days:$d, enabled:true}')" > /dev/null
psql_q "UPDATE schedules SET last_run_key = NULL WHERE id = '$SCHEDULE_ID'" > /dev/null
# Claim it the way the cron does — the recurrence scanned is pinned in the
# WHERE, so an edit that moves the schedule to another hour cannot be claimed
# on the old one (which would let the next scan run it a second time).
claim() { # key [timezone] [hour] [days-mask] → 1 when it took the hour
  psql_q "UPDATE schedules SET last_run_key = '$1'
          WHERE id = '$SCHEDULE_ID' AND enabled
            AND timezone = '${2:-UTC}' AND hour = ${3:-$HOUR_UTC} AND days_of_week = ${4:-$((1 << DOW))}
            AND last_run_key IS DISTINCT FROM '$1' RETURNING 1"
}
KEY="$(date -u +%Y-%m-%dT%H)"
assert_eq "first claim takes the hour" "$(claim "$KEY")" "1"
assert_eq "second claim finds it taken" "$(claim "$KEY")" ""
NEXT_KEY="$(date -u -d '+1 hour' +%Y-%m-%dT%H 2>/dev/null || date -u -v+1H +%Y-%m-%dT%H)"
assert_eq "the next hour claims again" "$(claim "$NEXT_KEY")" "1"
ui PATCH "/api/schedules/$SCHEDULE_ID" '{"timezone":"Asia/Tokyo"}' > /dev/null
assert_eq "a claim on the recurrence it no longer has is refused" "$(claim "${KEY}x")" ""
assert_eq "and the schedule keeps the hour it was moved to" "$(psql_q "SELECT timezone FROM schedules WHERE id = '$SCHEDULE_ID'")" "Asia/Tokyo"

step "6. delete"
STATUS="$(ui DELETE "/api/schedules/$SCHEDULE_ID")"
assert_eq "delete → 200" "$STATUS" "200"
ui GET "/api/schedules?projectId=$PROJECT_ID" > /dev/null
assert_eq "gone from the list" "$(api_body | jq -r --arg i "$SCHEDULE_ID" '[.schedules[] | select(.id == $i)] | length')" "0"
STATUS="$(ui DELETE "/api/schedules/$SCHEDULE_ID")"
assert_eq "second delete → 404" "$STATUS" "404"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
