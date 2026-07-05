#!/usr/bin/env bash
# Regression for the public unsubscribe-token route family. The HMAC-signed
# token in the email footer IS the auth — these routes bypass RLS via raw
# createDb() and flip do_not_contact for anyone holding a valid token (a
# CAN-SPAM/CASL compliance promise). The token verify logic alone is
# unit-tested; this covers the DB write/read end-to-end.
#
# Covers, against the local stack (localhost:8787 API + 54322 Postgres):
#
#   1. GET  /api/unsubscribe/:token  — returns prospect summary, alreadyUnsubscribed=false
#   2. tampered / malformed / wrong-tenant token  — 400, no DB change
#   3. POST /api/unsubscribe/:token  — flips prospects.do_not_contact=true
#   4. re-POST  — idempotent (stays true, still 200)
#   5. GET again  — alreadyUnsubscribed=true
#   6. POST /api/unsubscribe/:token/with-reason on a prospect WITH a 'sent' log
#      — DNC ratchet + a responses row (rejection feedback) recorded
#   7. with-reason on a prospect with NO 'sent' log  — still ratchets DNC, no
#      responses row (the no-prior-send branch the footer one-click can hit)
#   8. token for a nonexistent prospect  — 404 on GET and POST
#
# Tokens are minted by ./e2e/sign-unsubscribe-token.sh, which mirrors the
# backend HMAC format using UNSUBSCRIBE_TOKEN_SECRET from backend/.dev.vars.
# Curl-only, no Claude session, no Anthropic budget. Cleans up on exit.
#
# Usage:
#   ./e2e/regression-unsubscribe.sh
#   SKIP_CLEANUP=1 ./e2e/regression-unsubscribe.sh   # leave artifacts to inspect
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-unsub-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"

PASS=0
FAIL=0

step() { printf '\n=== %s ===\n' "$1" >&2; }
say()  { printf '  %s\n' "$1" >&2; }

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok  %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       want: %s\n       got:  %s\n' "$label" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      -d "$body" "$API_URL$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}

# Public unsubscribe routes take NO Authorization header — the URL token is the
# auth. `pub` echoes the HTTP status on stdout and writes the response body to
# $PUB_OUT (created once in the parent so command-subst call sites can read it
# back).
PUB_OUT=""
pub() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$PUB_OUT" -w '%{http_code}' -X "$method" -H 'Content-Type: application/json' \
      -d "$body" "$API_URL$path"
  else
    curl -sS -o "$PUB_OUT" -w '%{http_code}' -X "$method" "$API_URL$path"
  fi
}
pub_body() { cat "$PUB_OUT"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

require_jq
PUB_OUT="$(mktemp)"
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
  rm -f "${PUB_OUT:-}" 2>/dev/null || true
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2
    echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2
  echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  # responses/outreach_logs cascade off the prospect FK; drop prospects + orgs.
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed prospects (plain / with-sent-log / no-log)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed plain)" \
  --argjson s "$(mkseed sent)" \
  --argjson n "$(mkseed nolog)" \
  '{projectId:$pid, prospects:[$a,$s,$n]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_PLAIN="$(pid_of plain)"; P_SENT="$(pid_of sent)"; P_NOLOG="$(pid_of nolog)"
[[ -n "$P_PLAIN" && -n "$P_SENT" && -n "$P_NOLOG" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: plain=$P_PLAIN sent=$P_SENT nolog=$P_NOLOG"

# Give P_SENT a delivered outreach log so the with-reason path has a 'sent' row
# to attach a rejection response to. psql-seeded to keep this script decoupled
# from the record_outreach send path (its own regression).
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
            VALUES ('$TENANT_ID', '$PROJECT_ID', $P_SENT, 'email', 'seed sent body', 'sent', now());" > /dev/null
say "seeded one 'sent' outreach_log for prospect $P_SENT"

TOK_PLAIN="$("$REPO_ROOT/e2e/sign-unsubscribe-token.sh" --prospect-id "$P_PLAIN" --tenant-id "$TENANT_ID")"
TOK_SENT="$("$REPO_ROOT/e2e/sign-unsubscribe-token.sh" --prospect-id "$P_SENT" --tenant-id "$TENANT_ID")"
TOK_NOLOG="$("$REPO_ROOT/e2e/sign-unsubscribe-token.sh" --prospect-id "$P_NOLOG" --tenant-id "$TENANT_ID")"

dnc_of() { psql_local "SELECT do_not_contact FROM prospects WHERE id=$1;"; }

step "Test 1: GET info before unsubscribe (alreadyUnsubscribed=false)"
GETCODE="$(pub GET "/api/unsubscribe/$TOK_PLAIN")"; GETBODY="$(pub_body)"
assert_eq "GET info http=200"                   "$GETCODE" "200"
assert_eq "GET info email"                       "$(echo "$GETBODY" | jq -r '.email')" "contact@$RUN_TAG-plain.example"
assert_eq "GET info organizationName"            "$(echo "$GETBODY" | jq -r '.organizationName')" "Org $RUN_TAG-plain.example"
assert_eq "GET info alreadyUnsubscribed=false"   "$(echo "$GETBODY" | jq -r '.alreadyUnsubscribed')" "false"

step "Test 2: tampered / malformed tokens reject with 400"
BAD_SIG_TOK="$("$REPO_ROOT/e2e/sign-unsubscribe-token.sh" --prospect-id "$P_PLAIN" --tenant-id "$TENANT_ID" --bad-sig)"
# Genuine tamper: keep P_PLAIN's signature but swap the prospectId field to
# P_SENT, so the HMAC no longer matches `${P_SENT}:${tenant}`. (A token re-signed
# for a different prospect/tenant needs the secret, so it isn't a forgery — the
# signature, not the field values, is what verification trusts.)
SWAP_ID_TOK="$P_SENT.${TOK_PLAIN#*.}"
assert_eq "bad-signature token → 400"   "$(pub GET "/api/unsubscribe/$BAD_SIG_TOK")"   "400"
assert_eq "malformed token → 400"       "$(pub GET "/api/unsubscribe/garbage")"        "400"
assert_eq "prospectId-swapped token → 400" "$(pub GET "/api/unsubscribe/$SWAP_ID_TOK")" "400"
assert_eq "tamper left DNC untouched"   "$(dnc_of "$P_PLAIN")" "f"

step "Test 3: POST flips do_not_contact=true"
POSTCODE="$(pub POST "/api/unsubscribe/$TOK_PLAIN")"; POSTBODY="$(pub_body)"
assert_eq "POST http=200"               "$POSTCODE" "200"
assert_eq "POST unsubscribed=true"      "$(echo "$POSTBODY" | jq -r '.unsubscribed')" "true"
assert_eq "prospect do_not_contact=t"   "$(dnc_of "$P_PLAIN")" "t"

step "Test 4: re-POST is idempotent (stays true, still 200)"
RECODE="$(pub POST "/api/unsubscribe/$TOK_PLAIN")"
assert_eq "re-POST http=200"            "$RECODE" "200"
assert_eq "prospect still do_not_contact=t" "$(dnc_of "$P_PLAIN")" "t"

step "Test 5: GET now reports alreadyUnsubscribed=true"
pub GET "/api/unsubscribe/$TOK_PLAIN" >/dev/null; GET2="$(pub_body)"
assert_eq "GET info alreadyUnsubscribed=true" "$(echo "$GET2" | jq -r '.alreadyUnsubscribed')" "true"

step "Test 6: with-reason on prospect WITH a 'sent' log → DNC + responses row"
WR_BODY='{"primary_reason":"not_relevant","free_text":"e2e unsubscribe with reason"}'
WRCODE="$(pub POST "/api/unsubscribe/$TOK_SENT/with-reason" "$WR_BODY")"; WRBODY="$(pub_body)"
assert_eq "with-reason http=200"        "$WRCODE" "200"
assert_eq "with-reason unsubscribed=true" "$(echo "$WRBODY" | jq -r '.unsubscribed')" "true"
assert_eq "with-reason responseId present" "$(echo "$WRBODY" | jq -r 'if .responseId == null then "null" else "present" end')" "present"
assert_eq "P_SENT do_not_contact=t"     "$(dnc_of "$P_SENT")" "t"
assert_eq "responses row recorded for P_SENT" \
  "$(psql_local "SELECT COUNT(*)::int FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$P_SENT AND r.response_type='rejection';")" "1"

step "Test 7: with-reason on prospect with NO 'sent' log → DNC, no responses row"
WRN_CODE="$(pub POST "/api/unsubscribe/$TOK_NOLOG/with-reason" "$WR_BODY")"; WRN_BODY="$(pub_body)"
assert_eq "no-log with-reason http=200" "$WRN_CODE" "200"
assert_eq "no-log unsubscribed=true"    "$(echo "$WRN_BODY" | jq -r '.unsubscribed')" "true"
assert_eq "no-log responseId absent/null" "$(echo "$WRN_BODY" | jq -r 'if (.responseId == null) then "null" else "present" end')" "null"
assert_eq "P_NOLOG do_not_contact=t"    "$(dnc_of "$P_NOLOG")" "t"
assert_eq "no responses row for P_NOLOG" \
  "$(psql_local "SELECT COUNT(*)::int FROM responses r JOIN outreach_logs o ON o.id=r.outreach_log_id WHERE o.prospect_id=$P_NOLOG;")" "0"

step "Test 8: token for a nonexistent prospect → 404"
GHOST_TOK="$("$REPO_ROOT/e2e/sign-unsubscribe-token.sh" --prospect-id 999999999 --tenant-id "$TENANT_ID")"
assert_eq "ghost GET → 404"  "$(pub GET  "/api/unsubscribe/$GHOST_TOK")" "404"
assert_eq "ghost POST → 404" "$(pub POST "/api/unsubscribe/$GHOST_TOK")" "404"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
