#!/usr/bin/env bash
# Regression for the data-maintenance delete surface + status guard.
#
# POST /prospects/delete-batch must delete only clean rows and skip (with a
# reason) DNC rows (suppression list), rows carrying any outreach history
# (sent or audit), rows linked to more than one project, and unknown ids.
# POST /organizations/delete-batch must delete only prospect-less orgs.
# PATCH /prospects/:id/status must reject status='new' when the prospect has
# sent outreach in the project (409), while audit-only history stays legal.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). No
# compliance/quota/Gmail dependency — fully self-host runnable. Curl-only
# (sent-outreach rows are seeded via psql to avoid the real send path),
# cleans up.
#
# Usage:
#   ./e2e/regression-prospect-delete.sh
#   SKIP_CLEANUP=1 ./e2e/regression-prospect-delete.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-prospdel-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
PROJECT_B_NAME="$RUN_TAG project-b"

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
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, industry:"saas", matchReason:"seed"}'
}

require_jq
API_OUT="$(mktemp)"
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
  rm -f "${API_OUT:-}" 2>/dev/null || true
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving projects and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  for pid in "${PROJECT_ID:-}" "${PROJECT_B_ID:-}"; do
    [[ -n "$pid" ]] && { api DELETE "/api/projects/$pid" > /dev/null || true; say "deleted project $pid"; }
  done
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create 2 projects + seed 5 prospects into project A"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
PROJECT_B_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_B_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" && -n "$PROJECT_B_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project A=$PROJECT_ID B=$PROJECT_B_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed clean)" --argjson b "$(mkseed dnc)" --argjson c "$(mkseed sent)" \
  --argjson d "$(mkseed audit)" --argjson e "$(mkseed xlink)" \
  '{projectId:$pid, prospects:[$a,$b,$c,$d,$e]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=5" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "5"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_CLEAN="$(pid_of clean)"; P_DNC="$(pid_of dnc)"; P_SENT="$(pid_of sent)"; P_AUDIT="$(pid_of audit)"; P_XLINK="$(pid_of xlink)"
[[ -n "$P_CLEAN" && -n "$P_DNC" && -n "$P_SENT" && -n "$P_AUDIT" && -n "$P_XLINK" ]] \
  || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "clean=$P_CLEAN dnc=$P_DNC sent=$P_SENT audit=$P_AUDIT xlink=$P_XLINK"

step "arrange guard states"
api PATCH "/api/prospects/$P_DNC/do-not-contact" "$(jq -nc '{doNotContact:true}')" > /dev/null
assert_eq "dnc flag set" "$(psql_local "SELECT do_not_contact FROM prospects WHERE id=$P_DNC;")" "t"

psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status)
            VALUES ('$TENANT_ID', '$PROJECT_ID', $P_SENT, 'email', 'seed sent', 'sent');" > /dev/null
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, skip_reason)
            VALUES ('$TENANT_ID', '$PROJECT_ID', $P_AUDIT, 'email', 'seed skip', 'skipped', 'other');" > /dev/null
assert_eq "sent row seeded" "$(psql_local "SELECT COUNT(*) FROM outreach_logs WHERE prospect_id=$P_SENT;")" "1"
assert_eq "audit row seeded" "$(psql_local "SELECT COUNT(*) FROM outreach_logs WHERE prospect_id=$P_AUDIT;")" "1"

LINK_RESP="$(api POST "/api/projects/$PROJECT_B_ID/prospects/link" "$(jq -nc --argjson id "$P_XLINK" '{links:[{prospectId:$id, matchReason:"cross-link seed"}]}')")"
assert_eq "xlink linked to project B" "$(psql_local "SELECT COUNT(*) FROM project_prospects WHERE prospect_id=$P_XLINK;")" "2"

step "status guard: sent history blocks 'new', audit-only does not"
CODE="$(api_status PATCH "/api/prospects/$P_SENT/status" "$(jq -nc --arg pid "$PROJECT_ID" '{projectId:$pid, status:"new"}')")"
assert_eq "sent prospect → status new rejected (409)" "$CODE" "409"
CODE="$(api_status PATCH "/api/prospects/$P_SENT/status" "$(jq -nc --arg pid "$PROJECT_ID" '{projectId:$pid, status:"deferred"}')")"
assert_eq "sent prospect → status deferred allowed (200)" "$CODE" "200"
CODE="$(api_status PATCH "/api/prospects/$P_AUDIT/status" "$(jq -nc --arg pid "$PROJECT_ID" '{projectId:$pid, status:"new"}')")"
assert_eq "audit-only prospect → status new allowed (200)" "$CODE" "200"

step "delete-batch: mixed batch classifies every row"
ORG_CLEAN="$(psql_local "SELECT organization_id FROM prospects WHERE id=$P_CLEAN;")"
ORG_DNC="$(psql_local "SELECT organization_id FROM prospects WHERE id=$P_DNC;")"
DEL_BODY="$(jq -nc --argjson ids "[$P_CLEAN,$P_CLEAN,$P_DNC,$P_SENT,$P_AUDIT,$P_XLINK,999999999]" '{prospectIds:$ids}')"
CODE="$(api_status POST /api/prospects/delete-batch "$DEL_BODY")"; BODY="$(api_body)"
assert_eq "delete-batch → 200" "$CODE" "200"
assert_eq "deleted=1 (duplicate id counted once)" "$(echo "$BODY" | jq -r '.deleted')" "1"
assert_eq "deletedIds=[clean]" "$(echo "$BODY" | jq -c '.deletedIds')" "[$P_CLEAN]"
skip_reason_of() { echo "$BODY" | jq -r --argjson id "$1" '.skipped[]? | select(.prospectId==$id) | .reason'; }
assert_eq "dnc skipped: do_not_contact" "$(skip_reason_of "$P_DNC")" "do_not_contact"
assert_eq "sent skipped: has_outreach_history" "$(skip_reason_of "$P_SENT")" "has_outreach_history"
assert_eq "audit skipped: has_outreach_history" "$(skip_reason_of "$P_AUDIT")" "has_outreach_history"
assert_eq "xlink skipped: linked_to_multiple_projects" "$(skip_reason_of "$P_XLINK")" "linked_to_multiple_projects"
assert_eq "bogus id skipped: not_found" "$(skip_reason_of 999999999)" "not_found"
assert_eq "orphaned orgs=[clean's org]" "$(echo "$BODY" | jq -c '.orphanedOrganizationIds')" "[$ORG_CLEAN]"
assert_eq "clean prospect row gone" "$(psql_local "SELECT COUNT(*) FROM prospects WHERE id=$P_CLEAN;")" "0"
assert_eq "clean project link cascaded" "$(psql_local "SELECT COUNT(*) FROM project_prospects WHERE prospect_id=$P_CLEAN;")" "0"
assert_eq "dnc prospect row survives" "$(psql_local "SELECT COUNT(*) FROM prospects WHERE id=$P_DNC;")" "1"

step "delete-batch validation: empty ids → 400"
CODE="$(api_status POST /api/prospects/delete-batch '{"prospectIds":[]}')"
assert_eq "empty prospectIds rejected (400)" "$CODE" "400"

step "organizations delete-batch: only prospect-less orgs deleted"
ORG_BODY="$(jq -nc --argjson ids "[$ORG_CLEAN,$ORG_DNC,999999999]" '{organizationIds:$ids}')"
CODE="$(api_status POST /api/organizations/delete-batch "$ORG_BODY")"; BODY="$(api_body)"
assert_eq "org delete-batch → 200" "$CODE" "200"
assert_eq "org deleted=1" "$(echo "$BODY" | jq -r '.deleted')" "1"
org_skip_reason_of() { echo "$BODY" | jq -r --argjson id "$1" '.skipped[]? | select(.organizationId==$id) | .reason'; }
assert_eq "org with prospects skipped: has_prospects" "$(org_skip_reason_of "$ORG_DNC")" "has_prospects"
assert_eq "bogus org skipped: not_found" "$(org_skip_reason_of 999999999)" "not_found"
assert_eq "orphan org row gone" "$(psql_local "SELECT COUNT(*) FROM organizations WHERE id=$ORG_CLEAN;")" "0"
assert_eq "populated org row survives" "$(psql_local "SELECT COUNT(*) FROM organizations WHERE id=$ORG_DNC;")" "1"

step "result"
printf '\nPASS=%d FAIL=%d\n' "$PASS" "$FAIL" >&2
[[ "$FAIL" -eq 0 ]] || exit 2
exit 0
