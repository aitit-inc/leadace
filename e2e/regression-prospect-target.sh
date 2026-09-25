#!/usr/bin/env bash
# Regression for the person's word on project targets (set_prospect_target).
#
# project_prospects.qualified decides whether a project targets a prospect;
# Ace's Prerequisite check writes it, and so does the person. This checks that
#   1. qualified=false keeps a prospect out of get_outbound_targets and the
#      default list,
#   2. target=false takes a prospect out, and the send path refuses it,
#   3. target=true puts a ruled-out prospect in; unknown ids are reported,
#   4. a draft written before the person took the prospect out is not sent,
#   5. an MCP client may take prospects out but not put them in (no approval
#      card to show there).
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Sets
# tenant compliance temporarily (the send path 412s without it) and restores
# it. Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-prospect-target.sh
#   SKIP_CLEANUP=1 ./e2e/regression-prospect-target.sh
#
# Exit status: 0 all passed · 1 setup/HTTP failure · 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-target-$(date +%s)"
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

# Is prospect-id $2 in the JSON list $1? prints y/n.
has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
}

mkseed() {
  local dom="$RUN_TAG-$1.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$1" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

set_target() {
  api PATCH "/api/projects/$PROJECT_ID/prospects/target" \
    "$(jq -nc --argjson ids "[$1]" --argjson t "$2" '{prospectIds:$ids, target:$t}')"
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

ORIG_LEGAL="$(psql_local "SELECT COALESCE(legal_name,'') FROM tenants WHERE id='$TENANT_ID';")"
ORIG_ADDR="$(psql_local "SELECT COALESCE(physical_address,'') FROM tenants WHERE id='$TENANT_ID';")"
ORIG_COUNTRY="$(psql_local "SELECT COALESCE(default_sender_country,'') FROM tenants WHERE id='$TENANT_ID';")"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and tagged rows." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  psql_local "DELETE FROM outreach_logs WHERE tenant_id='$TENANT_ID' AND project_id='${PROJECT_ID:-}';" > /dev/null 2>&1 || true
  if [[ -n "${PROJECT_ID:-}" ]]; then api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true; say "deleted project $PROJECT_ID"; fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  psql_local "UPDATE tenants SET
    legal_name = NULLIF('$ORIG_LEGAL',''),
    physical_address = NULLIF('$ORIG_ADDR',''),
    default_sender_country = NULLIF('$ORIG_COUNTRY','')
    WHERE id='$TENANT_ID';" > /dev/null || true
  say "dropped tagged rows + restored tenant compliance"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed 2 US prospects; Ace rules one out"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"send"}' > /dev/null
SEED_RESP="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" --argjson a "$(mkseed fit)" --argjson b "$(mkseed ruled)" '{projectId:$pid, prospects:[$a,$b]}')")"
assert_eq "seed inserted=2" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "2"
LIST="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_FIT="$(pid_of fit)"; P_RULED="$(pid_of ruled)"
[[ -n "$P_FIT" && -n "$P_RULED" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
psql_local "UPDATE project_prospects SET qualified = false WHERE project_id='$PROJECT_ID' AND prospect_id=$P_RULED;" > /dev/null
say "ids: fit=$P_FIT ruled=$P_RULED"

step "Test 1: Ace's verdict keeps the ruled-out prospect out"
R="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "fit reachable"          "$(has "$R" "$P_FIT")"   "y"
assert_eq "ruled not reachable"    "$(has "$R" "$P_RULED")" "n"
L="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
assert_eq "ruled not in targets list" "$(has "$L" "$P_RULED")" "n"
L="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200&scope=all")"
assert_eq "ruled in scope=all"     "$(has "$L" "$P_RULED")" "y"

step "Test 2: target=false takes the fit prospect out, and the send path refuses it"
assert_eq "override reports the update" "$(set_target "$P_FIT" false | jq -c '.updatedIds')" "[$P_FIT]"
R="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "excluded not reachable" "$(has "$R" "$P_FIT")" "n"
psql_local "UPDATE tenants SET legal_name='E2E Target', physical_address='123 Test St', default_sender_country='US' WHERE id='$TENANT_ID';" > /dev/null
SEND_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$P_FIT" --arg b "e2e target body $(openssl rand -hex 32)" '{projectId:$pid, prospectId:$prid, subject:"e2e", body:$b}')"
SEND_OUT="$(mktemp)"
SEND_CODE="$(curl -sS -o "$SEND_OUT" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$SEND_BODY" "$API_URL/api/outreach/send-and-record")"
assert_eq "send refused (422)" "$SEND_CODE" "422"
assert_eq "refused as no target" "$(jq -r '.error // ""' "$SEND_OUT" | grep -q 'not a target' && echo y || echo n)" "y"
rm -f "$SEND_OUT"

step "Test 3: target=true puts the ruled-out prospect in"
set_target "$P_FIT,$P_RULED" true > /dev/null
R="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "included reachable" "$(has "$R" "$P_RULED")" "y"
assert_eq "fit reachable again" "$(has "$R" "$P_FIT")" "y"
assert_eq "not-in-project id reported" "$(set_target 999999999 false | jq -c '.notInProjectIds')" "[999999999]"

step "Test 4: a draft written before the exclusion is not sent"
DRAFT_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$P_FIT" --arg b "e2e target draft $(openssl rand -hex 32)" \
  '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:$b, status:"pending_review"}')"
DRAFT_ID="$(api POST /api/outreach "$DRAFT_BODY" | jq -r '.id // ""')"
[[ -n "$DRAFT_ID" ]] || { echo "draft create failed" >&2; exit 1; }
set_target "$P_FIT" false > /dev/null
DRAFT_OUT="$(mktemp)"
DRAFT_CODE="$(curl -sS -o "$DRAFT_OUT" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" "$API_URL/api/outreach/drafts/$DRAFT_ID/send")"
assert_eq "draft send refused (422)" "$DRAFT_CODE" "422"
assert_eq "draft refused as no target" "$(jq -r '.error // ""' "$DRAFT_OUT" | grep -q 'not a target' && echo y || echo n)" "y"
rm -f "$DRAFT_OUT"

step "Test 5: an MCP client can take prospects out but not put them in"
TOKEN_MCP="$("$REPO_ROOT/e2e/mint-jwt.sh" --aud mcp)"
mcp_target() {
  curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H "Authorization: Bearer $TOKEN_MCP" -H 'Content-Type: application/json' \
    -d "$(jq -nc --argjson t "$1" --argjson id "$P_RULED" '{prospectIds:[$id], target:$t}')" "$API_URL/api/projects/$PROJECT_ID/prospects/target"
}
assert_eq "mcp target=true refused (403)" "$(mcp_target true)"  "403"
assert_eq "mcp target=false allowed"      "$(mcp_target false)" "200"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
[[ "$FAIL" -gt 0 ]] && exit 2
exit 0
