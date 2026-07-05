#!/usr/bin/env bash
# Regression for the inquiry landing unsubscribe ratchet.
#
# recordInquiryUnsubscribe (services/inquiry-session.ts) ALWAYS ratchets
# prospects.do_not_contact=true for the recipient landing opt-out. Two legs:
#   (1) CHIP-LESS FIRST-TAP — empty body on an open session: DNC set directly,
#       NO responses row written, session closed (outcome='unsubscribed',
#       response_id NULL), project_prospects.status intentionally NOT flipped.
#   (2) WITH-CHIP FOLLOW-UP on the SAME session — a later POST carrying a
#       primary_reason attaches exactly one rejection responses row to the same
#       session (CAS), keeping outcome='unsubscribed' and DNC true; idempotent
#       (first chip wins).
# If either leg failed to ratchet DNC, an opted-out recipient keeps getting
# mailed — a CAN-SPAM/CASL violation. Public route: the URL short_id IS the auth.
#
# inquiry_tokens + the 'sent' outreach_log are psql-seeded (no API mints a token
# outside the real send path); the open inquiry_session is materialized by the
# public GET /api/inquiry/:shortId. Curl-only, no tenant-settings state, cleans up.
#
# Usage:
#   ./e2e/regression-inquiry-unsubscribe.sh
#   SKIP_CLEANUP=1 ./e2e/regression-inquiry-unsubscribe.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-inqunsub-$(date +%s)"
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

# Public (token-as-auth) request: NO Authorization header. Body → $API_OUT, code on stdout.
API_OUT=""
pub_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" "$API_URL$path"
  fi
}
api_body() { cat "$API_OUT"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

dnc()       { psql_local "SELECT do_not_contact FROM prospects WHERE id=$1;"; }
rej_count() { psql_local "SELECT COUNT(*)::int FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$1 AND r.response_type='rejection';"; }
all_resp()  { psql_local "SELECT COUNT(*)::int FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$1;"; }
sid8()      { node -e 'process.stdout.write(require("crypto").createHash("md5").update(process.argv[1]).digest("hex").slice(0,8))' "${RUN_TAG}$1"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

seed_token_and_open() {
  local prid="$1" sid="$2"
  local olid
  # psql prints the RETURNING value AND an "INSERT 0 1" status tag — take the value line.
  olid="$(psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
    VALUES ('$TENANT_ID','$PROJECT_ID',$prid,'email','seed sent body','sent', now()) RETURNING id;" | head -1)"
  psql_local "INSERT INTO inquiry_tokens (short_id, tenant_id, prospect_id, outreach_log_id)
    VALUES ('$sid','$TENANT_ID',$prid,$olid);" > /dev/null
  pub_status GET "/api/inquiry/$sid" > /dev/null
  api_body | jq -r '.session.id'
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

step "create project + enable inquiry landing + seed prospects"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"
# Inquiry landing now defaults off (link-free cold mail); this suite exercises
# the inquiry flow, so opt in explicitly.
api PUT "/api/projects/$PROJECT_ID/settings" '{"inquiryLandingEnabled":true}' > /dev/null

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson cl "$(mkseed chipless)" --argjson wc "$(mkseed withchip)" --argjson ld "$(mkseed lead)" \
  '{projectId:$pid, prospects:[$cl,$wc,$ld]}')"
assert_eq "seed inserted=3" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "3"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_CL="$(pid_of chipless)"; P_WC="$(pid_of withchip)"; P_LD="$(pid_of lead)"
[[ -n "$P_CL" && -n "$P_WC" && -n "$P_LD" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }

SID_CL="$(sid8 cl)"; SID_WC="$(sid8 wc)"; SID_LD="$(sid8 ld)"
SESS_CL="$(seed_token_and_open "$P_CL" "$SID_CL")"
SESS_WC="$(seed_token_and_open "$P_WC" "$SID_WC")"
SESS_LD="$(seed_token_and_open "$P_LD" "$SID_LD")"
[[ -n "$SESS_CL" && -n "$SESS_WC" && -n "$SESS_LD" ]] || { echo "failed to open sessions" >&2; exit 1; }
say "sessions: chipless=$SESS_CL withchip=$SESS_WC lead=$SESS_LD"

step "open-session GET returns opened/not-closed"
pub_status GET "/api/inquiry/$SID_CL" > /dev/null; BODY="$(api_body)"
assert_eq "GET landing → outcome=opened" "$(echo "$BODY" | jq -r '.session.outcome')" "opened"
assert_eq "GET landing → not closed" "$(echo "$BODY" | jq -r '.session.closed')" "false"

step "Leg 1: chip-less first-tap (empty body) ratchets DNC, writes NO response"
CODE="$(pub_status POST "/api/inquiry/$SID_CL/unsubscribe" '{}')"; BODY="$(api_body)"
assert_eq "chip-less unsubscribe → 200" "$CODE" "200"
assert_eq "unsubscribed=true" "$(echo "$BODY" | jq -r '.unsubscribed')" "true"
assert_eq "responseId is null" "$(echo "$BODY" | jq -r 'if .responseId==null then "null" else "present" end')" "null"
assert_eq "prospect do_not_contact=true (PRIMARY invariant)" "$(dnc "$P_CL")" "t"
assert_eq "NO responses row written" "$(all_resp "$P_CL")" "0"
assert_eq "session closed unsubscribed, responseId null" \
  "$(psql_local "SELECT outcome||'|'||(closed_at IS NOT NULL)||'|'||(response_id IS NULL) FROM inquiry_sessions WHERE id=$SESS_CL;")" \
  "unsubscribed|true|true"
assert_eq "project_prospects.status NOT flipped (stays 'new')" \
  "$(psql_local "SELECT status FROM project_prospects WHERE prospect_id=$P_CL AND project_id='$PROJECT_ID';")" "new"

step "Leg 1b: idempotent re-POST empty body stays 200, DNC still true"
assert_eq "re-POST chip-less → 200" "$(pub_status POST "/api/inquiry/$SID_CL/unsubscribe" '{}')" "200"
assert_eq "DNC still true" "$(dnc "$P_CL")" "t"

step "Leg 2: with-chip FOLLOW-UP attaches one rejection response to the SAME session"
assert_eq "withchip chip-less close → 200" "$(pub_status POST "/api/inquiry/$SID_WC/unsubscribe" '{}')" "200"
CODE="$(pub_status POST "/api/inquiry/$SID_WC/unsubscribe" '{"primary_reason":"not_relevant","free_text":"e2e landing unsub reason"}')"; BODY="$(api_body)"
assert_eq "with-chip follow-up → 200" "$CODE" "200"
assert_eq "follow-up returns a responseId" "$(echo "$BODY" | jq -r 'if .responseId==null then "null" else "present" end')" "present"
assert_eq "prospect DNC stays true across both legs" "$(dnc "$P_WC")" "t"
assert_eq "exactly ONE rejection response attached" "$(rej_count "$P_WC")" "1"
assert_eq "session response_id set, outcome unchanged" \
  "$(psql_local "SELECT (response_id IS NOT NULL)||'|'||outcome FROM inquiry_sessions WHERE id=$SESS_WC;")" \
  "true|unsubscribed"
assert_eq "rejection_feedback.primary_reason persisted" \
  "$(psql_local "SELECT rejection_feedback->>'primary_reason' FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$P_WC AND r.response_type='rejection' LIMIT 1;")" \
  "not_relevant"

step "Leg 2b: idempotent re-chip (first wins) — still exactly one rejection response"
assert_eq "second chip → 200" "$(pub_status POST "/api/inquiry/$SID_WC/unsubscribe" '{"primary_reason":"budget"}')" "200"
assert_eq "still exactly ONE rejection response" "$(rej_count "$P_WC")" "1"

step "Negative: unsubscribe on a session closed with a non-unsubscribe outcome → 409"
psql_local "UPDATE inquiry_sessions SET outcome='lead', closed_at=now() WHERE id=$SESS_LD;" > /dev/null
assert_eq "unsubscribe on lead-closed session → 409" "$(pub_status POST "/api/inquiry/$SID_LD/unsubscribe" '{}')" "409"
assert_eq "lead prospect DNC unchanged (false)" "$(dnc "$P_LD")" "f"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
