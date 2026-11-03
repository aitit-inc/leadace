#!/usr/bin/env bash
# Regression for the answers Ace drafts to replies waiting for one (#802):
#
#   1. An answer is listed with its reply; saving rewrites it, keeps Ace's draft
#      as written, and sends nothing.
#   2. Sending refuses a text that still holds a {placeholder} (422), and the
#      answer stays a draft.
#   3. Gmail leg (gated on a Gmail identity + E2E_RECIPIENT_OVERRIDE): the text
#      given goes out from the outreach's mailbox and is kept as the answer,
#      'sent' with its time; the reply counts as answered, and a second send is
#      refused (409). Without Gmail: 412, the answer is back to a draft, the
#      reply still waits.
#   4. A reply already answered (marked by hand) is not sent to (409).
#   5. A prospect on do-not-contact is not sent to (422).
#
# The answer rows are inserted by hand: the reply ingest that drafts them needs
# a real inbox. Curl-only, single tenant, one project, cleans up.
#
# Usage:
#   ./e2e/regression-answers.sh
#   SKIP_CLEANUP=1 ./e2e/regression-answers.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-answers-$(date +%s)"
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
code() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}

command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

mkseed() {
  local dom="$RUN_TAG-$1.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$1" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# A sent outreach, a reply to it, and the answer Ace drafted; echoes the response id.
reply_with_answer() {
  local prospect="$1" log rid
  log="$(api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prospect" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"A question", body:"seed", status:"sent"}')" | jq -r '.id // ""')"
  [[ -n "$log" ]] || { echo "outreach for $prospect failed" >&2; exit 1; }
  rid="$(api POST /api/responses "$(jq -nc --argjson lid "$log" \
    '{outreachLogId:$lid, channel:"email", content:"Could you send the deck?", sentiment:"positive", responseType:"reply", markDoNotContact:false}')" | jq -r '.id // ""')"
  [[ -n "$rid" ]] || { echo "reply for $prospect failed" >&2; exit 1; }
  psql_local "INSERT INTO answers (tenant_id, response_id, to_email, subject, ace_body, body) VALUES ('$TENANT_ID', $rid, 'contact@$RUN_TAG-x.example', 'Re: A question', 'Here it is: {deck link}', 'Here it is: {deck link}');" > /dev/null
  echo "$rid"
}
answer_field() { psql_local "SELECT $2 FROM answers WHERE response_id=$1;"; }
answered()     { psql_local "SELECT answered_at IS NOT NULL FROM responses WHERE id=$1;"; }

TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

step "preflight"
[[ "$(curl -sS "$API_URL/health" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy" >&2; exit 1; }
USER_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_ID' LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || { echo "no tenant for user $USER_ID — sign in once via the frontend first" >&2; exit 1; }
say "tenant_id=$TENANT_ID"

ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
echo "$ORIGINAL_TENANT" | jq -e 'has("legalName")' >/dev/null 2>&1 \
  || { echo "could not read tenant settings: $ORIGINAL_TENANT" >&2; exit 1; }
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and tenant settings in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  local restore_body
  restore_body="$(jq -nc --arg legal "$ORIG_LEGAL" --arg addr "$ORIG_ADDR" --arg country "$ORIG_COUNTRY" \
    '{legalName: (if $legal=="" then null else $legal end),
      physicalAddress: (if $addr=="" then null else $addr end),
      defaultSenderCountry: (if $country=="" then null else $country end)}')"
  if api PUT /api/tenant-settings "$restore_body" | jq -e 'has("legalName")' >/dev/null 2>&1; then
    say "restored tenant settings"
  else
    echo "  COULD NOT restore tenant settings — put them back by hand: $restore_body" >&2
    rc=1
  fi
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance, a project, three prospects that each wrote back"
api PUT /api/tenant-settings '{"legalName":"E2E Answers Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson a "$(mkseed send)" --argjson b "$(mkseed marked)" --argjson c "$(mkseed dnc)" \
  '{projectId:$pid, prospects:[$a,$b,$c]}')"
assert_eq "seed inserted=3" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "3"
LIST="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email==$e) | .prospectId' | head -1; }
P_SEND="$(pid_of send)"; P_MARKED="$(pid_of marked)"; P_DNC="$(pid_of dnc)"
[[ -n "$P_SEND" && -n "$P_MARKED" && -n "$P_DNC" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
R_SEND="$(reply_with_answer "$P_SEND")"; R_MARKED="$(reply_with_answer "$P_MARKED")"; R_DNC="$(reply_with_answer "$P_DNC")"
say "replies send=$R_SEND marked=$R_MARKED dnc=$R_DNC"

step "the answer is listed with its reply; saving rewrites it and sends nothing"
listed() { api GET "/api/projects/$PROJECT_ID/responses?ids=$1" | jq -r '.responses[0].answerEmail | "\(.to) | \(.subject) | \(.status) | \(.body)"'; }
assert_eq "listed with its reply"       "$(listed "$R_SEND")" "contact@$RUN_TAG-x.example | Re: A question | draft | Here it is: {deck link}"
assert_eq "send with a placeholder 422" "$(code POST "/api/responses/$R_SEND/answer/send" '{"body":"Here it is: {deck link}"}')" "422"
assert_eq "still a draft"               "$(answer_field "$R_SEND" status)" "draft"
assert_eq "save 200"                    "$(code PUT "/api/responses/$R_SEND/answer" '{"body":"Here it is: https://example.com/deck.pdf"}')" "200"
assert_eq "saved body"                  "$(answer_field "$R_SEND" body)" "Here it is: https://example.com/deck.pdf"
assert_eq "Ace's draft kept as written" "$(answer_field "$R_SEND" ace_body)" "Here it is: {deck link}"
assert_eq "saving sends nothing"        "$(answered "$R_SEND")" "f"

step "sending (Gmail-backed when this tenant has Gmail and the recipient override)"
GMAIL_ID="$(psql_local "SELECT identity_id FROM sending_identities WHERE tenant_id = '$TENANT_ID' AND provider = 'gmail_oauth' AND auth_revoked_at IS NULL AND parent_identity_id IS NULL LIMIT 1;")"
HAS_OVERRIDE="$(grep -cE '^E2E_RECIPIENT_OVERRIDE=.' "$REPO_ROOT/backend/.dev.vars" 2>/dev/null || true)"
SENT='{"body":"Here is the deck: https://example.com/deck.pdf"}'
if [[ -n "$GMAIL_ID" && "$HAS_OVERRIDE" != "0" ]]; then
  psql_local "UPDATE outreach_logs SET sending_identity_id = '$GMAIL_ID' WHERE id = (SELECT outreach_log_id FROM responses WHERE id = $R_SEND);" > /dev/null
  assert_eq "send 200"                 "$(code POST "/api/responses/$R_SEND/answer/send" "$SENT")" "200"
  assert_eq "answer sent, time kept"   "$(answer_field "$R_SEND" "status || ' ' || (sent_at IS NOT NULL)")" "sent true"
  assert_eq "listed with what was sent" "$(listed "$R_SEND")" "contact@$RUN_TAG-x.example | Re: A question | sent | Here is the deck: https://example.com/deck.pdf"
  assert_eq "Ace's draft still kept"   "$(answer_field "$R_SEND" ace_body)" "Here it is: {deck link}"
  assert_eq "the reply is answered"    "$(answered "$R_SEND")" "t"
  assert_eq "a second send 409"        "$(code POST "/api/responses/$R_SEND/answer/send" "$SENT")" "409"
else
  say "no Gmail identity or no E2E_RECIPIENT_OVERRIDE — asserting the mailbox-missing leg"
  assert_eq "send 412"                 "$(code POST "/api/responses/$R_SEND/answer/send" "$SENT")" "412"
  assert_eq "back to a draft"          "$(answer_field "$R_SEND" status)" "draft"
  assert_eq "the reply still waits"    "$(answered "$R_SEND")" "f"
fi

step "an answered reply and a do-not-contact prospect are not sent to"
CLEAN='{"body":"Here it is: https://example.com/deck.pdf"}'
code PUT "/api/responses/$R_MARKED/answer" "$CLEAN" > /dev/null
code PUT "/api/responses/$R_DNC/answer" "$CLEAN" > /dev/null
assert_eq "mark answered 200"           "$(code POST "/api/responses/$R_MARKED/mark-answered")" "200"
assert_eq "send to answered 409"        "$(code POST "/api/responses/$R_MARKED/answer/send" "$CLEAN")" "409"
psql_local "UPDATE prospects SET do_not_contact = true WHERE id = $P_DNC;" > /dev/null
assert_eq "send to DNC 422"             "$(code POST "/api/responses/$R_DNC/answer/send" "$CLEAN")" "422"
assert_eq "DNC answer still a draft"    "$(answer_field "$R_DNC" status)" "draft"

step "summary"
say "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 2
