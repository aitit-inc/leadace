#!/usr/bin/env bash
# Net-new regression for record_evaluation priorityUpdates scope
# (coverage-audit §2 gap #26).
#
# recordEvaluation's bulk per-industry priority override is restricted to
# status='new' project_prospects rows (services/evaluations.ts:407-414, the
# `pp.status = 'new'` filter). If the UPDATE...FROM VALUES regresses, it
# overwrites priority on already-contacted/responded prospects, corrupting the
# live pipeline. The per-industry rowsAffected report must count exactly the
# 'new' rows in that industry (RETURNING-counted, seeded at 0 for every
# requested industry — so a zero-match industry reports rowsAffected=0).
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). No
# compliance/quota/Gmail dependency — fully self-host runnable. Curl-only,
# cleans up. Does NOT touch tenant settings.
#
# Usage:
#   ./e2e/regression-record-evaluation-priority.sh
#   SKIP_CLEANUP=1 ./e2e/regression-record-evaluation-priority.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-evalprio-$(date +%s)"
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

pp_priority() { psql_local "SELECT priority FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
pp_status()   { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }

mkseed_ind() {
  local tag="$1" industry="$2"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" --arg ind "$industry" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, industry:$ind, matchReason:"seed"}'
}

set_status() {
  local prid="$1" status="$2"
  api PATCH "/api/prospects/$prid/status" "$(jq -nc --arg pid "$PROJECT_ID" --arg s "$status" '{projectId:$pid, status:$s}')" > /dev/null
  assert_eq "set prospect $prid status=$status" "$(pp_status "$prid")" "$status"
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

step "create project + seed 6 prospects across 3 industries (all status='new', priority=3)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson sa "$(mkseed_ind saas-a saas)" --argjson sb "$(mkseed_ind saas-b saas)" --argjson sc "$(mkseed_ind saas-c saas)" \
  --argjson ra "$(mkseed_ind retail-a retail)" --argjson rb "$(mkseed_ind retail-b retail)" \
  --argjson fa "$(mkseed_ind fintech-a fintech)" \
  '{projectId:$pid, prospects:[$sa,$sb,$sc,$ra,$rb,$fa]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=6" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "6"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_SAAS_A="$(pid_of saas-a)"; P_SAAS_B="$(pid_of saas-b)"; P_SAAS_C="$(pid_of saas-c)"
P_RETAIL_A="$(pid_of retail-a)"; P_RETAIL_B="$(pid_of retail-b)"; P_FINTECH_A="$(pid_of fintech-a)"
[[ -n "$P_SAAS_A" && -n "$P_SAAS_B" && -n "$P_SAAS_C" && -n "$P_RETAIL_A" && -n "$P_RETAIL_B" && -n "$P_FINTECH_A" ]] \
  || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "saas: A=$P_SAAS_A B=$P_SAAS_B C=$P_SAAS_C | retail: A=$P_RETAIL_A B=$P_RETAIL_B | fintech: A=$P_FINTECH_A"

step "mixed status WITHIN industry 'saas': B→contacted, C→responded (A stays new)"
set_status "$P_SAAS_B" contacted
set_status "$P_SAAS_C" responded
assert_eq "baseline saas-A priority=3" "$(pp_priority "$P_SAAS_A")" "3"
assert_eq "baseline saas-B priority=3" "$(pp_priority "$P_SAAS_B")" "3"
assert_eq "baseline saas-C priority=3" "$(pp_priority "$P_SAAS_C")" "3"

step "record_evaluation priorityUpdates: saas→1, retail→5, fintech→2"
EVAL_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  '{projectId:$pid, metrics:{}, findings:"e2e eval", improvements:"e2e improvements",
    priorityUpdates:[{industry:"saas",priority:1},{industry:"retail",priority:5},{industry:"fintech",priority:2}]}')"
CODE="$(api_status POST /api/evaluations "$EVAL_BODY")"; BODY="$(api_body)"
assert_eq "record_evaluation → 201" "$CODE" "201"
assert_eq "response returns an evaluationId" "$(echo "$BODY" | jq -r 'if .evaluationId==null then "null" else "present" end')" "present"
ra_of() { echo "$BODY" | jq -r --arg i "$1" '.priorityUpdates[]? | select(.industry==$i) | .rowsAffected'; }
assert_eq "saas rowsAffected=1 (only the 'new' row, not all 3)" "$(ra_of saas)" "1"
assert_eq "retail rowsAffected=2 (both 'new')" "$(ra_of retail)" "2"
assert_eq "fintech rowsAffected=1" "$(ra_of fintech)" "1"

step "DB: only status='new' rows changed; contacted/responded rows untouched"
assert_eq "saas 'new' row got priority 1" "$(pp_priority "$P_SAAS_A")" "1"
assert_eq "saas 'contacted' row UNCHANGED (still 3)" "$(pp_priority "$P_SAAS_B")" "3"
assert_eq "saas 'responded' row UNCHANGED (still 3)" "$(pp_priority "$P_SAAS_C")" "3"
assert_eq "saas-B status still 'contacted'" "$(pp_status "$P_SAAS_B")" "contacted"
assert_eq "saas-C status still 'responded'" "$(pp_status "$P_SAAS_C")" "responded"
assert_eq "both retail 'new' rows got priority 5" \
  "$(psql_local "SELECT count(*)::int FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id IN ($P_RETAIL_A,$P_RETAIL_B) AND priority=5;")" "2"
assert_eq "fintech 'new' row got priority 2" "$(pp_priority "$P_FINTECH_A")" "2"

step "Negative leg: industry with zero 'new' rows reports rowsAffected=0, changes nothing"
set_status "$P_SAAS_A" contacted
EVAL2_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  '{projectId:$pid, metrics:{}, findings:"e2e eval2", improvements:"e2e", priorityUpdates:[{industry:"saas",priority:4}]}')"
CODE="$(api_status POST /api/evaluations "$EVAL2_BODY")"; BODY="$(api_body)"
assert_eq "2nd eval → 201" "$CODE" "201"
assert_eq "saas rowsAffected=0 (no 'new' rows left)" "$(echo "$BODY" | jq -r '.priorityUpdates[]? | select(.industry=="saas") | .rowsAffected')" "0"
assert_eq "saas-A priority unchanged (still 1, not 4)" "$(pp_priority "$P_SAAS_A")" "1"

step "Schema guard: duplicate industry → 400"
DUP_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  '{projectId:$pid, metrics:{}, findings:"e2e", improvements:"e2e", priorityUpdates:[{industry:"saas",priority:1},{industry:"saas",priority:2}]}')"
CODE="$(api_status POST /api/evaluations "$DUP_BODY")"
assert_eq "duplicate industry rejected → 400" "$CODE" "400"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
