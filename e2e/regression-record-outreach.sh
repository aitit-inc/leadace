#!/usr/bin/env bash
# Regression for the record_outreach MCP path (POST /api/outreach), which
# regression-outbound.sh (send-and-record) does not cover. record_outreach
# with status='sent' must re-run the SAME guard set as send-and-record
# (compliance → quota → do-not-contact → country) and flip the prospect to
# 'contacted'; if a guard is dropped here a mis-send gets logged as a legit
# 'sent' through the back door (compliance leak).
#
# Covers, against the local stack (localhost:8787 API + 54322 Postgres). Quota
# is self-host=unlimited so the quota leg is NOT exercised here (it needs the
# cloud-edition harness); this asserts the compliance/DNC/country gates + the
# contacted flip + the draft/failed branches:
#
#   1a. status='sent' with tenant compliance INCOMPLETE → 412, no row, prospect 'new'
#   1b. status='pending_review' (draft) with compliance incomplete → 201
#       (draft bypasses the send-only gates), row pending_review, no contacted flip
#   2.  status='sent' to a do-not-contact prospect → 422, no row, prospect 'new'
#   3.  status='sent' to an unsupported-country (GB) prospect → 422, no row, 'new'
#   4.  status='sent' happy path (US, compliant) → 201, 'sent' row, prospect 'contacted'
#   5.  status='failed' → 201, 'failed' row with errorMessage, NOT contacted,
#       next_outreach_after deferred (re-eligibility stamp)
#
# Snapshots + restores the tenant's compliance fields (shared tenant state),
# same as regression-outbound.sh. Curl-only, no Claude session. Cleans up.
#
# Usage:
#   ./e2e/regression-record-outreach.sh
#   SKIP_CLEANUP=1 ./e2e/regression-record-outreach.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-recout-$(date +%s)"
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

mkseed() {
  local tag="$1" country="$2"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg c "$country" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:$c, countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

rec_body() {
  local prid="$1" status="$2"
  if [[ "$status" == "failed" ]]; then
    jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" --arg s "$status" \
      '{projectId:$pid, prospectId:$prid, channel:"email", body:"e2e record_outreach body", status:$s, errorMessage:"smtp 550 mailbox unavailable"}'
  else
    jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" --arg s "$status" \
      '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"e2e record_outreach body", status:$s}'
  fi
}

pp_status() { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
log_count() { psql_local "SELECT COUNT(*)::int FROM outreach_logs WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }

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
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>}, run rows, and tenant settings as-is." >&2
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

step "create project + seed prospects (us / gb / dnc / draft / fail)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson us "$(mkseed us US)" --argjson gb "$(mkseed gb GB)" --argjson dnc "$(mkseed dnc US)" \
  --argjson draft "$(mkseed draft US)" --argjson fail "$(mkseed fail US)" \
  '{projectId:$pid, prospects:[$us,$gb,$dnc,$draft,$fail]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=5" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "5"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_US="$(pid_of us)"; P_GB="$(pid_of gb)"; P_DNC="$(pid_of dnc)"; P_DRAFT="$(pid_of draft)"; P_FAIL="$(pid_of fail)"
[[ -n "$P_US" && -n "$P_GB" && -n "$P_DNC" && -n "$P_DRAFT" && -n "$P_FAIL" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: us=$P_US gb=$P_GB dnc=$P_DNC draft=$P_DRAFT fail=$P_FAIL"

psql_local "UPDATE prospects SET do_not_contact = true WHERE id = $P_DNC;" > /dev/null
say "flagged prospect $P_DNC do_not_contact"

step "Test 1a: status='sent' with compliance INCOMPLETE → 412, no row"
api PUT /api/tenant-settings '{"legalName":null,"physicalAddress":null,"defaultSenderCountry":null}' > /dev/null
CODE="$(api_status POST /api/outreach "$(rec_body "$P_US" sent)")"; BODY="$(api_body)"
assert_eq "sent w/o compliance → 412" "$CODE" "412"
assert_eq "error = compliance incomplete" "$(echo "$BODY" | jq -r '.error // ""')" "Tenant compliance settings incomplete"
assert_eq "no outreach_logs row for P_US" "$(log_count "$P_US")" "0"
assert_eq "P_US still 'new'" "$(pp_status "$P_US")" "new"

step "Test 1b: status='pending_review' (draft) bypasses the send-only gates → 201"
DCODE="$(api_status POST /api/outreach "$(rec_body "$P_DRAFT" pending_review)")"; DBODY="$(api_body)"
assert_eq "draft → 201" "$DCODE" "201"
assert_eq "draft returns an id" "$(echo "$DBODY" | jq -r 'if .id == null then "null" else "present" end')" "present"
assert_eq "draft row is pending_review" \
  "$(psql_local "SELECT status FROM outreach_logs WHERE prospect_id=$P_DRAFT ORDER BY id DESC LIMIT 1;")" "pending_review"
assert_eq "P_DRAFT not flipped to contacted" "$(pp_status "$P_DRAFT")" "new"

step "set tenant compliance ready"
SET_TENANT="$(api PUT /api/tenant-settings '{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}')"
assert_eq "tenant.legalName set" "$(echo "$SET_TENANT" | jq -r '.legalName')" "E2E Test Corp"

step "Test 2: status='sent' to a do-not-contact prospect → 422, no row"
CODE="$(api_status POST /api/outreach "$(rec_body "$P_DNC" sent)")"; BODY="$(api_body)"
assert_eq "sent to DNC → 422" "$CODE" "422"
assert_eq "error = do-not-contact" "$(echo "$BODY" | jq -r '.error // ""')" "Prospect is on do-not-contact list"
assert_eq "no row for P_DNC" "$(log_count "$P_DNC")" "0"
assert_eq "P_DNC still 'new'" "$(pp_status "$P_DNC")" "new"

step "Test 3: status='sent' to an unsupported-country (GB) prospect → 422, no row"
CODE="$(api_status POST /api/outreach "$(rec_body "$P_GB" sent)")"; BODY="$(api_body)"
assert_eq "sent to GB → 422" "$CODE" "422"
assert_eq "error mentions country not supported" \
  "$(echo "$BODY" | jq -r '.error // ""' | grep -qi 'not supported' && echo y || echo n)" "y"
assert_eq "no row for P_GB" "$(log_count "$P_GB")" "0"
assert_eq "P_GB still 'new'" "$(pp_status "$P_GB")" "new"

step "Test 4: status='sent' happy path (US, compliant) → 201, row sent, contacted"
CODE="$(api_status POST /api/outreach "$(rec_body "$P_US" sent)")"; BODY="$(api_body)"
assert_eq "sent happy → 201" "$CODE" "201"
SENT_ID="$(echo "$BODY" | jq -r '.id // ""')"
assert_eq "returns an id" "$([[ -n "$SENT_ID" ]] && echo present || echo null)" "present"
assert_eq "outreach_logs row status='sent'" \
  "$(psql_local "SELECT status FROM outreach_logs WHERE id=$SENT_ID;")" "sent"
assert_eq "P_US flipped to 'contacted'" "$(pp_status "$P_US")" "contacted"

step "Test 5: status='failed' → 201, failed row, NOT contacted, deferred"
CODE="$(api_status POST /api/outreach "$(rec_body "$P_FAIL" failed)")"; BODY="$(api_body)"
assert_eq "failed → 201" "$CODE" "201"
FAIL_ID="$(echo "$BODY" | jq -r '.id // ""')"
assert_eq "failed row status='failed'" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$FAIL_ID;")" "failed"
assert_eq "failed row has errorMessage" "$(psql_local "SELECT error_message IS NOT NULL FROM outreach_logs WHERE id=$FAIL_ID;")" "t"
assert_eq "P_FAIL NOT flipped to contacted" "$(pp_status "$P_FAIL")" "new"
# Re-eligibility recycle stamp lives on prospects.next_outreach_after (GREATEST).
assert_eq "P_FAIL next_outreach_after deferred (stamped)" \
  "$(psql_local "SELECT next_outreach_after IS NOT NULL FROM prospects WHERE id=$P_FAIL;")" "t"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
