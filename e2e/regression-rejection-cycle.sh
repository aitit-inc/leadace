#!/usr/bin/env bash
# Net-new regression for the rejection-cycle ratchet (coverage-audit §2 gap #16).
#
# Two invariants in recordResponse (services/responses.ts):
#
#  (1) PER-PROJECT SCOPE. The rejectionCycle COUNT filters by BOTH prospectId
#      AND projectId (responses.ts:160-169 — the eq(outreachLogs.projectId,...)
#      join condition is load-bearing). The cap fires at
#      rejectionCycle >= maxReapproachCycles, flipping the (prospect,project)
#      link to 'rejected' and forcing do_not_contact. A query-shape regression
#      dropping the projectId filter would let project A's rejections inflate
#      project B's counter and wrongly hard-reject the SAME prospect in B.
#
#  (2) BOUNCE / CAP-REACHED DNC FLIP. A bounce sets prospects.do_not_contact=true
#      and the link status to 'inactive'; a cap-reached rejection sets DNC too.
#
# Single tenant, TWO projects, a SHARED prospect linked to both (the B link is a
# direct psql INSERT — batchRegister never re-links an existing-email prospect).
# Uses pending_review outreach rows (no send guards / no quota) + recordResponse
# (no quota guard) — fully self-host runnable. Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-rejection-cycle.sh
#   SKIP_CLEANUP=1 ./e2e/regression-rejection-cycle.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-rejcycle-$(date +%s)"

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

ppA_status() { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_A';"; }
ppB_status() { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_B';"; }
dnc()        { psql_local "SELECT do_not_contact FROM prospects WHERE id=$1;"; }
# rejection count for a (prospect, project)
rej_count()  { psql_local "SELECT COUNT(*)::int FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$1 AND o.project_id='$2' AND r.response_type='rejection';"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# Seed a pending_review outreach row; echoes its log id.
seed_log() {
  local pid="$1" prid="$2"
  api POST /api/outreach "$(jq -nc --arg pid "$pid" --argjson prid "$prid" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"seed", status:"pending_review"}')" | jq -r '.id // ""'
}

rej_body()    { jq -nc --argjson lid "$1" --arg w "$2" \
  '{outreachLogId:$lid, channel:"email", content:"e2e rejection", sentiment:"negative", responseType:"rejection",
    markDoNotContact:false, rejectionFeedback:{version:1, primary_reason:"wrong_timing", preferred_recontact_window:$w, submitted_at:(now|todateiso8601)}}'; }
bounce_body() { jq -nc --argjson lid "$1" \
  '{outreachLogId:$lid, channel:"email", content:"e2e bounce", sentiment:"neutral", responseType:"bounce"}'; }

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
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving projects ${PROJECT_A:-<none>}/${PROJECT_B:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  for p in "${PROJECT_A:-}" "${PROJECT_B:-}"; do
    [[ -n "$p" ]] && { api DELETE "/api/projects/$p" > /dev/null || true; say "deleted project $p"; }
  done
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create 2 projects, cap reapproach cycles at 2 on both"
PROJECT_A="$(api POST /api/projects "$(jq -nc --arg n "$RUN_TAG A" '{name:$n}')" | jq -r '.id // ""')"
PROJECT_B="$(api POST /api/projects "$(jq -nc --arg n "$RUN_TAG B" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_A" && -n "$PROJECT_B" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_a=$PROJECT_A project_b=$PROJECT_B"
assert_eq "project A maxReapproachCycles=2" "$(api PUT "/api/projects/$PROJECT_A/settings" '{"maxReapproachCycles":2}' | jq -r '.maxReapproachCycles')" "2"
assert_eq "project B maxReapproachCycles=2" "$(api PUT "/api/projects/$PROJECT_B/settings" '{"maxReapproachCycles":2}' | jq -r '.maxReapproachCycles')" "2"

step "seed shared + bounce prospects into project A"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_A" --argjson sh "$(mkseed shared)" --argjson bo "$(mkseed bounce)" \
  '{projectId:$pid, prospects:[$sh,$bo]}')"
assert_eq "seed inserted=2" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "2"
LIST_RESP="$(api GET "/api/projects/$PROJECT_A/prospects?limit=200")"
P_SHARED="$(echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-shared.example" '.prospects[]? | select(.email==$e) | .prospectId' | head -1)"
P_BOUNCE="$(echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-bounce.example" '.prospects[]? | select(.email==$e) | .prospectId' | head -1)"
[[ -n "$P_SHARED" && -n "$P_BOUNCE" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
say "shared=$P_SHARED bounce=$P_BOUNCE"

# Link the shared prospect to project B (no API re-links an existing-email prospect).
psql_local "INSERT INTO project_prospects (tenant_id, project_id, prospect_id, match_reason, priority, status, created_at, updated_at)
  VALUES ('$TENANT_ID','$PROJECT_B',$P_SHARED,'e2e shared link',3,'new',now(),now());" > /dev/null
assert_eq "shared prospect linked to B (status new)" "$(ppB_status "$P_SHARED")" "new"

step "seed one pending_review outreach row per (prospect,project)"
LOG_A_SHARED="$(seed_log "$PROJECT_A" "$P_SHARED")"
LOG_B_SHARED="$(seed_log "$PROJECT_B" "$P_SHARED")"
LOG_A_BOUNCE="$(seed_log "$PROJECT_A" "$P_BOUNCE")"
[[ -n "$LOG_A_SHARED" && -n "$LOG_B_SHARED" && -n "$LOG_A_BOUNCE" ]] || { echo "failed to seed outreach logs" >&2; exit 1; }
say "logs: A_shared=$LOG_A_SHARED B_shared=$LOG_B_SHARED A_bounce=$LOG_A_BOUNCE"

step "Leg 1a: 1st rejection in A (uncapped) → deferred, no DNC, window stamped"
CODE="$(api_status POST /api/responses "$(rej_body "$LOG_A_SHARED" 3_months)")"; BODY="$(api_body)"
assert_eq "1st rejection → 201" "$CODE" "201"
assert_eq "response returns an id" "$(echo "$BODY" | jq -r 'if .id==null then "null" else "present" end')" "present"
assert_eq "A rejection cycle count = 1" "$(rej_count "$P_SHARED" "$PROJECT_A")" "1"
assert_eq "A link status = 'deferred' (uncapped)" "$(ppA_status "$P_SHARED")" "deferred"
assert_eq "do_not_contact still false" "$(dnc "$P_SHARED")" "f"
assert_eq "next_outreach_after stamped" "$(psql_local "SELECT next_outreach_after IS NOT NULL FROM prospects WHERE id=$P_SHARED;")" "t"

step "Leg 1b: 2nd rejection in A → cap reached → rejected + DNC"
CODE="$(api_status POST /api/responses "$(rej_body "$LOG_A_SHARED" 3_months)")"
assert_eq "2nd rejection → 201" "$CODE" "201"
assert_eq "A rejection cycle count = 2 (cap)" "$(rej_count "$P_SHARED" "$PROJECT_A")" "2"
assert_eq "A link status flips to 'rejected'" "$(ppA_status "$P_SHARED")" "rejected"
assert_eq "cap-reached forces do_not_contact=true" "$(dnc "$P_SHARED")" "t"

step "reset shared prospect (clear DNC + B link to 'new') before the per-project scope test"
psql_local "UPDATE prospects SET do_not_contact=false WHERE id=$P_SHARED;
  UPDATE project_prospects SET status='new' WHERE prospect_id=$P_SHARED AND project_id='$PROJECT_B';" > /dev/null
say "reset done"

step "Leg 2 (LOAD-BEARING): single rejection in B is NOT contaminated by A's 2"
CODE="$(api_status POST /api/responses "$(rej_body "$LOG_B_SHARED" 3_months)")"
assert_eq "B 1st rejection → 201" "$CODE" "201"
assert_eq "B rejection cycle count = 1 (per-project scope)" "$(rej_count "$P_SHARED" "$PROJECT_B")" "1"
assert_eq "B link status = 'deferred' NOT 'rejected'" "$(ppB_status "$P_SHARED")" "deferred"
assert_eq "do_not_contact still false (not cross-flipped from A)" "$(dnc "$P_SHARED")" "f"

step "Leg 3: bounce on a separate prospect → DNC + inactive"
CODE="$(api_status POST /api/responses "$(bounce_body "$LOG_A_BOUNCE")")"
assert_eq "bounce → 201" "$CODE" "201"
assert_eq "bounce forces do_not_contact=true" "$(dnc "$P_BOUNCE")" "t"
assert_eq "bounce flips A link status to 'inactive'" "$(ppA_status "$P_BOUNCE")" "inactive"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
