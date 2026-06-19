#!/usr/bin/env bash
# Regression for the P1 day-scale follow-up sequence (services/outreach.ts
# markProspectContacted + services/prospects.ts listReachable third arm +
# services/responses.ts stop-wiring + services/project-settings.ts kill-switch).
#
# The existing suites cover send-and-record / skip / reachable but predate
# follow-ups and never assert the day-scale re-pick. This unit drives the full
# new loop against the local stack (localhost:8787 API + 54322 Postgres):
#
#   1. A new project seeds follow_up_sequence.enabled=true (opt-out for new data).
#   2. A 'sent' outreach seeds the sequence: next_followup_after = sentAt + gap[0]
#      (default 3d), followup_touches=1, outreach_logs.touch_number=1, status flips
#      to 'contacted'. The prospect is NOT reachable while next_followup_after is
#      in the future.
#   3. Rewinding next_followup_after into the past re-surfaces the prospect via
#      the follow-up arm, labeled cycle.kind='short_cycle_followup', touchNumber=2.
#   4. A second 'sent' advances the sequence (touches=2, next gap=7d, touch_number=2).
#   5. A real reply (responseType=reply) flips status to 'responded' AND clears
#      next_followup_after (stop-wiring).
#   6. The enabled=false kill-switch clears an in-progress next_followup_after.
#   7. A cadence-only PUT that omits `enabled` reads back disabled and ALSO clears
#      (the effective-disabled fix — not just an explicit false).
#   8. A disabled project never seeds a sequence (existing-rows-off / no-backfill).
#
# Curl-only, no Claude session / Anthropic budget. Single tenant, one project,
# cleans up.
#
# Usage:
#   ./e2e/regression-followup-sequence.sh
#   SKIP_CLEANUP=1 ./e2e/regression-followup-sequence.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-followup-$(date +%s)"
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

reachable_has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
}
cycle_kind()  { echo "$1" | jq -r --argjson id "$2" '.prospects[]? | select(.prospectId==$id) | .cycle.kind'; }
cycle_touch() { echo "$1" | jq -r --argjson id "$2" '.prospects[]? | select(.prospectId==$id) | .cycle.touchNumber'; }

touches()   { psql_local "SELECT followup_touches FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
ppstatus()  { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
nfa_null()  { psql_local "SELECT (next_followup_after IS NULL) FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
touchnum()  { psql_local "SELECT touch_number FROM outreach_logs WHERE id=$1;"; }
rewind_nfa(){ psql_local "UPDATE project_prospects SET next_followup_after = NOW() - INTERVAL '1 minute' WHERE prospect_id=$1 AND project_id='$PROJECT_ID' AND next_followup_after IS NOT NULL;" > /dev/null; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# POST a 'sent' outreach; echoes the log id (triggers markProspectContacted).
send_outreach() {
  api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"seed", status:"sent"}')" | jq -r '.id // ""'
}
reply_body() { jq -nc --argjson lid "$1" \
  '{outreachLogId:$lid, channel:"email", content:"interested, tell me more", sentiment:"positive", responseType:"reply", markDoNotContact:false}'; }

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

step "create project (new ⇒ follow_up_sequence.enabled=true)"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_id=$PROJECT_ID"
assert_eq "new project follow-up enabled" \
  "$(api GET "/api/projects/$PROJECT_ID/settings" | jq -r '.followUpSequence.enabled')" "true"

step "seed 4 US prospects (seq / kill / fixb / disabled)"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed seq)" --argjson b "$(mkseed kill)" --argjson c "$(mkseed fixb)" --argjson d "$(mkseed disabled)" \
  '{projectId:$pid, prospects:[$a,$b,$c,$d]}')"
assert_eq "seed inserted=4" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "4"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email==$e) | .prospectId' | head -1; }
P_SEQ="$(pid_of seq)"; P_KILL="$(pid_of kill)"; P_FIXB="$(pid_of fixb)"; P_DIS="$(pid_of disabled)"
[[ -n "$P_SEQ" && -n "$P_KILL" && -n "$P_FIXB" && -n "$P_DIS" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
say "seq=$P_SEQ kill=$P_KILL fixb=$P_FIXB disabled=$P_DIS"

step "touch 1: a 'sent' outreach seeds the sequence"
LOG1="$(send_outreach "$P_SEQ")"
[[ -n "$LOG1" ]] || { echo "send touch 1 failed" >&2; exit 1; }
assert_eq "status flipped to contacted" "$(ppstatus "$P_SEQ")" "contacted"
assert_eq "followup_touches=1"          "$(touches "$P_SEQ")"  "1"
assert_eq "next_followup_after set"     "$(nfa_null "$P_SEQ")" "f"
assert_eq "touch_number=1 on the log"   "$(touchnum "$LOG1")"  "1"

step "not reachable while next_followup_after is in the future"
R0="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "seq prospect not yet reachable" "$(reachable_has "$R0" "$P_SEQ")" "n"

step "rewind next_followup_after → re-surfaces as short_cycle_followup"
rewind_nfa "$P_SEQ"
R1="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "seq prospect now reachable"  "$(reachable_has "$R1" "$P_SEQ")" "y"
assert_eq "cycle.kind=short_cycle_followup" "$(cycle_kind "$R1" "$P_SEQ")"  "short_cycle_followup"
assert_eq "cycle.touchNumber=2"             "$(cycle_touch "$R1" "$P_SEQ")" "2"

step "touch 2: advance the sequence (gap[1]=7d, touch_number=2)"
LOG2="$(send_outreach "$P_SEQ")"
assert_eq "followup_touches=2"        "$(touches "$P_SEQ")"  "2"
assert_eq "next_followup_after re-armed" "$(nfa_null "$P_SEQ")" "f"
assert_eq "touch_number=2 on log 2"   "$(touchnum "$LOG2")"  "2"

step "stop-wiring: a real reply clears the sequence + flips to responded"
RESP_CODE="$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$(reply_body "$LOG2")" "$API_URL/api/responses")"
assert_eq "record reply 2xx"            "${RESP_CODE:0:1}" "2"
assert_eq "status=responded"            "$(ppstatus "$P_SEQ")" "responded"
assert_eq "next_followup_after cleared" "$(nfa_null "$P_SEQ")" "t"

step "kill-switch: PUT enabled:false clears an in-progress sequence"
send_outreach "$P_KILL" > /dev/null
assert_eq "kill prospect sequence seeded" "$(nfa_null "$P_KILL")" "f"
api PUT "/api/projects/$PROJECT_ID/settings" '{"followUpSequence":{"enabled":false}}' > /dev/null
assert_eq "kill-switch cleared next_followup_after" "$(nfa_null "$P_KILL")" "t"

step "re-enable, then cadence-only PUT (omits enabled) ⇒ effective-disabled also clears"
api PUT "/api/projects/$PROJECT_ID/settings" '{"followUpSequence":{"enabled":true}}' > /dev/null
send_outreach "$P_FIXB" > /dev/null
assert_eq "fixb sequence seeded"        "$(nfa_null "$P_FIXB")" "f"
api PUT "/api/projects/$PROJECT_ID/settings" '{"followUpSequence":{"gapDays":[2,5]}}' > /dev/null
assert_eq "effective-disabled cleared next_followup_after" "$(nfa_null "$P_FIXB")" "t"

step "disabled project never seeds (existing-rows-off / no-backfill)"
api PUT "/api/projects/$PROJECT_ID/settings" '{"followUpSequence":{"enabled":false}}' > /dev/null
send_outreach "$P_DIS" > /dev/null
assert_eq "disabled: contacted but no sequence" "$(ppstatus "$P_DIS")" "contacted"
assert_eq "disabled: next_followup_after stays NULL" "$(nfa_null "$P_DIS")" "t"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
