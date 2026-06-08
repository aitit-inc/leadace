#!/usr/bin/env bash
# Net-new regression for record_outreach_with_inquiry footer persistence +
# send-mode gates (coverage-audit §2 gap #15).
#
# recordOutreachWithInquiry (services/outreach.ts:364-450) has two invariants
# the curl harness never exercised:
#
#  (1) FOOTER PERSISTENCE BY MODE. willSend = project outboundMode==='send'.
#      The row is INSERTed with body=input.body. finalBody = input.body + footer
#      (footer = `\n\n---\n` + tenant legalName/address + the inquiry line
#      `Learn more, ask anything, or unsubscribe: <appUrl>/q/<shortId>`,
#      auth/google.ts:224 + domain/inquiry-footer.ts:2). ONLY for the
#      'pending_review' (draft) row is the persisted body overwritten to
#      finalBody — because the user copy-pastes the form/SNS draft from /drafts
#      and there is no send-time hook to append the footer. The 'pre_send' (send
#      mode) row keeps body==input.body verbatim; the footer lives only in the
#      returned finalBody, applied later at real send. A regression that baked
#      finalBody into the pre_send row would double-append the footer at send.
#
#  (2) SEND-MODE GATES. Compliance runs in BOTH modes (412 if incomplete). Only
#      in send mode do the DNC (422) and country (422) gates run before the
#      pre_send allocation; in draft mode they are skipped (a DNC/GB prospect
#      drafts successfully). Quota is self-host=unlimited so that leg never trips.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Snapshots
# + restores tenant compliance (shared state). Footer host is read from the
# allocated inquiry_tokens.short_id (env APP_URL-agnostic). Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-record-with-inquiry.sh
#   SKIP_CLEANUP=1 ./e2e/regression-record-with-inquiry.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-inqfooter-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
CORE_BODY="e2e inquiry core body marker"

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

# Substring check (handles embedded newlines, unlike grep's line model).
assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    printf '  ok  %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       expected substring: %s\n       in: %s\n' "$label" "$needle" "$haystack" >&2; FAIL=$((FAIL + 1))
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

last_log_id()     { psql_local "SELECT id FROM outreach_logs WHERE prospect_id=$1 AND project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"; }
last_log_body()   { psql_local "SELECT body FROM outreach_logs WHERE id=$1;"; }
token_shortid()   { psql_local "SELECT short_id FROM inquiry_tokens WHERE outreach_log_id=$1 LIMIT 1;"; }
pp_status()       { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
log_count()       { psql_local "SELECT COUNT(*)::int FROM outreach_logs WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }

mkseed() {
  local tag="$1" country="$2"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg c "$country" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:$c, countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

rwi_body() { jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" --arg b "$CORE_BODY" \
  '{projectId:$pid, prospectId:$prid, channel:"form", subject:"e2e", body:$b}'; }

set_mode() {
  local m="$1"
  local resp; resp="$(api PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg m "$m" '{outboundMode:$m}')")"
  assert_eq "project outboundMode=$m" "$(echo "$resp" | jq -r '.outboundMode // ""')" "$m"
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

ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"

restore_and_exit() {
  local rc=$?
  rm -f "${API_OUT:-}" 2>/dev/null || true
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

step "set tenant compliance ready + create project + seed prospects"
api PUT /api/tenant-settings '{"legalName":"E2E Inq Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson us "$(mkseed us US)" --argjson us2 "$(mkseed us2 US)" \
  --argjson gb "$(mkseed gb GB)" --argjson dnc "$(mkseed dnc US)" \
  '{projectId:$pid, prospects:[$us,$us2,$gb,$dnc]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=4" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "4"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_US="$(pid_of us)"; P_US2="$(pid_of us2)"; P_GB="$(pid_of gb)"; P_DNC="$(pid_of dnc)"
[[ -n "$P_US" && -n "$P_US2" && -n "$P_GB" && -n "$P_DNC" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
psql_local "UPDATE prospects SET do_not_contact = true WHERE id = $P_DNC;" > /dev/null
say "ids: us=$P_US us2=$P_US2 gb=$P_GB dnc=$P_DNC (dnc flagged)"

step "DRAFT mode: footer baked into the persisted pending_review body"
set_mode draft
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_US")")"; BODY="$(api_body)"
assert_eq "draft → 201" "$CODE" "201"
assert_eq "status=pending_review" "$(echo "$BODY" | jq -r '.status // ""')" "pending_review"
LID="$(last_log_id "$P_US")"; SID="$(token_shortid "$LID")"
assert_eq "inquiry_tokens short_id is 8-char [A-Za-z0-9_-]" \
  "$(echo "$SID" | grep -Eq '^[A-Za-z0-9_-]{8}$' && echo y || echo n)" "y"
DBBODY="$(last_log_body "$LID")"
assert_contains "persisted body carries the input core text" "$DBBODY" "$CORE_BODY"
assert_contains "persisted body carries the footer separator" "$DBBODY" $'\n\n---\n'
assert_contains "persisted body carries the tenant legalName line" "$DBBODY" "E2E Inq Corp"
assert_contains "persisted body carries the inquiry footer line" "$DBBODY" "Learn more, ask anything, or unsubscribe:"
assert_contains "persisted body carries the /q/<shortId> inquiry URL" "$DBBODY" "/q/$SID"
assert_eq "returned finalBody == persisted body" "$(echo "$BODY" | jq -r '.finalBody')" "$DBBODY"
assert_eq "draft does NOT flip prospect to contacted" "$(pp_status "$P_US")" "new"

step "DRAFT mode: send-only gates BYPASSED (DNC + GB still draft successfully)"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_DNC")")"; BODY="$(api_body)"
assert_eq "DNC drafts → 201 (no DNC gate in draft mode)" "$CODE" "201"
assert_eq "DNC draft status=pending_review" "$(echo "$BODY" | jq -r '.status // ""')" "pending_review"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_GB")")"; BODY="$(api_body)"
assert_eq "GB drafts → 201 (no country gate in draft mode)" "$CODE" "201"
assert_eq "GB draft status=pending_review" "$(echo "$BODY" | jq -r '.status // ""')" "pending_review"

step "SEND mode: pre_send body == input.body VERBATIM (footer NOT persisted)"
set_mode send
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_US2")")"; BODY="$(api_body)"
assert_eq "send → 201" "$CODE" "201"
assert_eq "status=pre_send" "$(echo "$BODY" | jq -r '.status // ""')" "pre_send"
LID2="$(last_log_id "$P_US2")"
assert_eq "pre_send persisted body == input.body (no footer)" "$(last_log_body "$LID2")" "$CORE_BODY"
FB="$(echo "$BODY" | jq -r '.finalBody')"
assert_contains "returned finalBody DOES carry the footer separator" "$FB" $'\n\n---\n'
assert_contains "returned finalBody DOES carry a /q/ inquiry URL" "$FB" "/q/"
assert_eq "returned finalBody starts with the input core text" \
  "$(echo "$BODY" | jq -r '.finalBody | startswith("'"$CORE_BODY"'")')" "true"

step "SEND mode: DNC + country gates fire (422, no row created)"
BEFORE_DNC="$(log_count "$P_DNC")"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_DNC")")"; BODY="$(api_body)"
assert_eq "send to DNC → 422" "$CODE" "422"
assert_eq "DNC error message" "$(echo "$BODY" | jq -r '.error // ""')" "Prospect is on do-not-contact list"
assert_eq "no new row for DNC prospect" "$(log_count "$P_DNC")" "$BEFORE_DNC"

BEFORE_GB="$(log_count "$P_GB")"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_GB")")"; BODY="$(api_body)"
assert_eq "send to GB → 422" "$CODE" "422"
assert_eq "GB country error message" "$(echo "$BODY" | jq -r '.error // ""')" "Recipient country GB is not supported"
assert_eq "no new row for GB prospect" "$(log_count "$P_GB")" "$BEFORE_GB"

step "Compliance gates BOTH modes: incomplete tenant → 412 even in draft mode"
api PUT /api/tenant-settings '{"legalName":null,"physicalAddress":null,"defaultSenderCountry":null}' > /dev/null
set_mode draft
BEFORE_US2="$(log_count "$P_US2")"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_US2")")"; BODY="$(api_body)"
assert_eq "incomplete compliance in draft mode → 412" "$CODE" "412"
assert_eq "compliance error message" "$(echo "$BODY" | jq -r '.error // ""')" "Tenant compliance settings incomplete"
assert_eq "no new row created on 412" "$(log_count "$P_US2")" "$BEFORE_US2"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
