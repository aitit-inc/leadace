#!/usr/bin/env bash
# Regression for the get_outbound_targets in-flight exclusion — the
# daily-cycle double-send guard.
#
# listReachable (GET /projects/:id/prospects/reachable) must drop a prospect
# that has in-flight outreach, so the same prospect is never handed to two
# callers. The NOT EXISTS subquery (services/prospects.ts) excludes it while
# an open pending_review draft exists, or a pre_send row younger than
# PRE_SEND_TTL_MINUTES (30, schema.ts); an older pre_send is treated as
# abandoned and the prospect becomes re-pickable. The daily-cycle "run
# outbound in series" rule papers over a regression here; this server guard
# is the real backstop.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). pre_send
# rows are hand-INSERTed via psql — no API mints pre_send except
# record-with-inquiry, which is too indirect for this unit. Does NOT touch
# tenant settings. Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-inflight-reachable.sh
#   SKIP_CLEANUP=1 ./e2e/regression-inflight-reachable.sh
#
# Exit status: 0 all passed · 1 setup/HTTP failure · 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-inflight-$(date +%s)"
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

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

# Is prospect-id $2 present in the listReachable JSON $1? prints y/n.
reachable_has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
}

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# Hand-INSERT a pre_send row. $1=prospectId, $2=sent_at SQL expr.
insert_presend() {
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
    VALUES ('$TENANT_ID','$PROJECT_ID',$1,'email','pre_send body','pre_send', $2);" > /dev/null
}

require_jq
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

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
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

step "create project + seed 3 US prospects (all eligible)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson draft "$(mkseed draft)" --argjson presend "$(mkseed presend)" --argjson aged "$(mkseed aged)" \
  '{projectId:$pid, prospects:[$draft,$presend,$aged]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_DRAFT="$(pid_of draft)"; P_PRESEND="$(pid_of presend)"; P_AGED="$(pid_of aged)"
[[ -n "$P_DRAFT" && -n "$P_PRESEND" && -n "$P_AGED" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: draft=$P_DRAFT presend=$P_PRESEND aged=$P_AGED"

step "baseline: all 3 reachable before any in-flight row"
R0="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "baseline draft reachable"   "$(reachable_has "$R0" "$P_DRAFT")"   "y"
assert_eq "baseline presend reachable" "$(reachable_has "$R0" "$P_PRESEND")" "y"
assert_eq "baseline aged reachable"    "$(reachable_has "$R0" "$P_AGED")"    "y"
assert_eq "baseline total=3"           "$(echo "$R0" | jq -r '.total')"      "3"

step "create in-flight rows (open pending_review draft + in-TTL pre_send + aged-out pre_send)"
# Open draft for P_DRAFT via the API — leaves project_prospects.status='new'.
DRAFT_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$P_DRAFT" \
  '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"draft body", status:"pending_review"}')"
DRAFT_RESP="$(api POST /api/outreach "$DRAFT_BODY")"
assert_eq "pending_review draft created" "$(echo "$DRAFT_RESP" | jq -r 'if .id then "yes" else "no" end')" "yes"
# In-TTL pre_send (sent_at NOW) and aged-out pre_send (sent_at 31m ago > 30m TTL).
insert_presend "$P_PRESEND" "NOW()"
insert_presend "$P_AGED" "NOW() - INTERVAL '31 minutes'"
say "inserted pre_send rows"

step "Test: in-flight exclusion (draft + in-TTL pre_send dropped; aged re-included)"
R1_CODE="$(curl -sS -o /tmp/inflight-r1.$$ -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API_URL/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
R1="$(cat /tmp/inflight-r1.$$)"; rm -f /tmp/inflight-r1.$$
assert_eq "reachable endpoint 200"          "$R1_CODE" "200"
assert_eq "open draft excludes prospect"    "$(reachable_has "$R1" "$P_DRAFT")"   "n"
assert_eq "in-TTL pre_send excludes prospect" "$(reachable_has "$R1" "$P_PRESEND")" "n"
assert_eq "aged-out pre_send re-includes"   "$(reachable_has "$R1" "$P_AGED")"    "y"
assert_eq "total = 1 survivor (aged)"       "$(echo "$R1" | jq -r '.total')"      "1"

step "DB-state guards (exclusion driven by in-flight subquery, not a status flip)"
assert_eq "rows = 1 pending_review + 2 pre_send" \
  "$(psql_local "SELECT string_agg(status::text, ',' ORDER BY status) FROM outreach_logs WHERE project_id='$PROJECT_ID';")" \
  "pending_review,pre_send,pre_send"
assert_eq "no prospect flipped to contacted" \
  "$(psql_local "SELECT count(*)::int FROM project_prospects WHERE project_id='$PROJECT_ID' AND status<>'new';")" "0"

step "Test: TTL boundary — re-anchoring aged pre_send to NOW re-excludes it"
psql_local "UPDATE outreach_logs SET sent_at = NOW() WHERE prospect_id=$P_AGED AND project_id='$PROJECT_ID' AND status='pre_send';" > /dev/null
R2="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "re-anchored aged now excluded" "$(reachable_has "$R2" "$P_AGED")" "n"
assert_eq "total = 0 (all in-flight)"      "$(echo "$R2" | jq -r '.total')"  "0"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
