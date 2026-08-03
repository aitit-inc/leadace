#!/usr/bin/env bash
# Regression pinning the dashboard funnel KPIs to the /outreach/recent stage
# drill-down filter.
#
# getDashboardSummary (services/dashboard.ts) counts DISTINCT prospects per
# funnel stage over stage events:
#   approached = outreach_logs status='sent' (sent_at in window)
#   reached    = inquiry_sessions opened in window
#   engaged    = countable reply (not bounce/auto_reply) OR inquiry outcome
#                in (inquired, lead, signup_clicked)
#   won        = meeting_request reply OR inquiry outcome in (lead, signup_clicked)
#
# funnelStageCondition (services/outreach.ts) filters the outreach-log list by
# the SAME events for the dashboard drill-down. This suite seeds one fixture
# per stage and asserts the two stay in lockstep: each KPI equals the number
# of DISTINCT prospects in the corresponding filtered list. Also pinned: the
# log-vs-prospect unit difference (a prospect with two sends appears twice in
# the list, once in the KPI), the period window (a 60-day-old send is out of
# period=30d, in all-time), inquiryOutcome surfacing on list rows, and 400 on
# an invalid stage value.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres).
# Snapshots + restores tenant compliance (shared state). Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-funnel-drilldown.sh
#   SKIP_CLEANUP=1 ./e2e/regression-funnel-drilldown.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-funnel-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"

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

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}

api_status_only() {
  local method="$1" path="$2"
  curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
}

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
require_openssl() { command -v openssl >/dev/null 2>&1 || { echo "need openssl on PATH (fixture bodies must be unique per call)" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

last_log_id()   { psql_local "SELECT id FROM outreach_logs WHERE prospect_id=$1 AND project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"; }
token_shortid() { psql_local "SELECT short_id FROM inquiry_tokens WHERE outreach_log_id=$1 LIMIT 1;"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

record_sent() {
  local prid="$1"
  api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e funnel", body:"e2e funnel body", status:"sent"}')" > /dev/null
}

record_response() {
  local lid="$1" rtype="$2"
  api POST /api/responses "$(jq -nc --argjson lid "$lid" --arg t "$rtype" \
    '{outreachLogId:$lid, channel:"email", content:"e2e funnel response", sentiment:"positive", responseType:$t}')" > /dev/null
}

require_jq
require_openssl
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

USER_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_ID' LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || { echo "no tenant for user $USER_ID — sign in once via the frontend first" >&2; exit 1; }
say "tenant_id=$TENANT_ID"

ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>}, run rows, tenant settings as-is." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  local restore_body
  restore_body="$(jq -nc --arg legal "$ORIG_LEGAL" --arg addr "$ORIG_ADDR" --arg country "$ORIG_COUNTRY" \
    '{legalName: (if $legal=="" then null else $legal end),
      physicalAddress: (if $addr=="" then null else $addr end),
      defaultSenderCountry: (if $country=="" then null else $country end)}')"
  api PUT /api/tenant-settings "$restore_body" > /dev/null || true
  say "restored tenant settings"
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance + project + prospects"
api PUT /api/tenant-settings '{"legalName":"E2E Funnel Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"
# The reached/engaged inquiry fixture needs a real inquiry token; the token is
# allocated by record-with-inquiry, which requires inquiry landing + send mode.
api PUT "/api/projects/$PROJECT_ID/settings" '{"inquiryLandingEnabled":true,"outboundMode":"send"}' > /dev/null

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson reply "$(mkseed reply)" --argjson inq "$(mkseed inq)" \
  --argjson won "$(mkseed won)" --argjson quiet "$(mkseed quiet)" \
  '{projectId:$pid, prospects:[$reply,$inq,$won,$quiet]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=4" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "4"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_REPLY="$(pid_of reply)"; P_INQ="$(pid_of inq)"; P_WON="$(pid_of won)"; P_QUIET="$(pid_of quiet)"
[[ -n "$P_REPLY" && -n "$P_INQ" && -n "$P_WON" && -n "$P_QUIET" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: reply=$P_REPLY inq=$P_INQ won=$P_WON quiet=$P_QUIET"

step "fixtures: one prospect per stage"
# P_REPLY: sent + countable reply → engaged. Second send backdated 60d → out of
# the 30d window but in all-time (and a 2-logs / 1-prospect unit fixture).
record_sent "$P_REPLY"
LID_REPLY="$(last_log_id "$P_REPLY")"
record_response "$LID_REPLY" "reply"
record_sent "$P_REPLY"
LID_REPLY_OLD="$(last_log_id "$P_REPLY")"
psql_local "UPDATE outreach_logs SET sent_at = now() - interval '60 days' WHERE id = $LID_REPLY_OLD;" > /dev/null
# P_INQ: sent via record-with-inquiry (allocates the token), then a session
# with outcome 'inquired' → reached + engaged.
api POST /api/outreach/record-with-inquiry "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$P_INQ" \
  --arg b "e2e funnel body $(openssl rand -hex 32)" \
  '{projectId:$pid, prospectId:$prid, channel:"form", subject:"e2e funnel", body:$b}')" > /dev/null
LID_INQ="$(last_log_id "$P_INQ")"
api PATCH "/api/outreach/$LID_INQ/status" '{"status":"sent"}' > /dev/null
SID_INQ="$(token_shortid "$LID_INQ")"
[[ -n "$SID_INQ" ]] || { echo "no inquiry token for log $LID_INQ" >&2; exit 1; }
psql_local "INSERT INTO inquiry_sessions (tenant_id, prospect_id, outreach_log_id, short_id, outcome)
  VALUES ('$TENANT_ID', $P_INQ, $LID_INQ, '$SID_INQ', 'inquired');" > /dev/null
# P_WON: sent + meeting_request reply → engaged + won.
record_sent "$P_WON"
LID_WON="$(last_log_id "$P_WON")"
record_response "$LID_WON" "meeting_request"
# P_QUIET: sent, no events → approached only.
record_sent "$P_QUIET"
say "fixtures in place"

step "dashboard KPIs (period=30d) match the fixture"
DASH="$(api GET "/api/projects/$PROJECT_ID/dashboard?period=30d")"
KPI_APPROACHED="$(echo "$DASH" | jq -r '.kpis.approached.current')"
KPI_REACHED="$(echo "$DASH" | jq -r '.kpis.reached.current')"
KPI_ENGAGED="$(echo "$DASH" | jq -r '.kpis.engaged.current')"
KPI_WON="$(echo "$DASH" | jq -r '.kpis.won.current')"
assert_eq "approached=4 (old send out of window, distinct prospects)" "$KPI_APPROACHED" "4"
assert_eq "reached=1" "$KPI_REACHED" "1"
assert_eq "engaged=3" "$KPI_ENGAGED" "3"
assert_eq "won=1" "$KPI_WON" "1"

step "drill-down lists agree with the KPIs (distinct prospects per stage)"
stage_list() { api GET "/api/projects/$PROJECT_ID/outreach/recent?stage=$1&period=30d"; }
distinct_prospects() { jq -r '[.logs[].prospectId] | unique | length'; }
assert_eq "stage=approached distinct == KPI" "$(stage_list approached | distinct_prospects)" "$KPI_APPROACHED"
assert_eq "stage=reached distinct == KPI" "$(stage_list reached | distinct_prospects)" "$KPI_REACHED"
assert_eq "stage=engaged distinct == KPI" "$(stage_list engaged | distinct_prospects)" "$KPI_ENGAGED"
assert_eq "stage=won distinct == KPI" "$(stage_list won | distinct_prospects)" "$KPI_WON"

REACHED_LIST="$(stage_list reached)"
assert_eq "stage=reached is P_INQ's log" "$(echo "$REACHED_LIST" | jq -r '.logs[0].id')" "$LID_INQ"
assert_eq "stage=reached row carries inquiryOutcome=inquired" "$(echo "$REACHED_LIST" | jq -r '.logs[0].inquiryOutcome')" "inquired"
assert_eq "stage=won is P_WON's log" "$(stage_list won | jq -r '.logs[0].id')" "$LID_WON"

step "period window + log-vs-prospect unit"
assert_eq "stage=approached period=30d total=4 logs" "$(stage_list approached | jq -r '.total')" "4"
ALL_APPROACHED="$(api GET "/api/projects/$PROJECT_ID/outreach/recent?stage=approached")"
assert_eq "stage=approached all-time total=5 logs (P_REPLY twice)" "$(echo "$ALL_APPROACHED" | jq -r '.total')" "5"
assert_eq "stage=approached all-time distinct prospects=4" "$(echo "$ALL_APPROACHED" | distinct_prospects)" "4"

step "strict validation"
assert_eq "invalid stage → 400" "$(api_status_only GET "/api/projects/$PROJECT_ID/outreach/recent?stage=bogus")" "400"
assert_eq "invalid period → 400" "$(api_status_only GET "/api/projects/$PROJECT_ID/outreach/recent?period=90d")" "400"

printf '\n=============== summary ===============\n' >&2
printf 'PASS=%d FAIL=%d\n' "$PASS" "$FAIL" >&2
[[ "$FAIL" -eq 0 ]] || exit 2
