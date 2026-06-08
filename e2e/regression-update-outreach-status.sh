#!/usr/bin/env bash
# Net-new regression for update_outreach_status — the confirm step of the
# two-phase form/SNS send (coverage-audit §2 gap #11).
#
# PATCH /outreach/:id/status resolves a 'pre_send' reservation to a terminal
# state, gated by a single atomic UPDATE ... WHERE status='pre_send'
# (services/outreach.ts:456-495):
#   - 'sent'   → row sent, error_message cleared, prospect flipped to 'contacted'
#   - 'failed' → row failed + error_message, prospect NOT contacted, re-eligibility
#                deferred (prospects.next_outreach_after stamped)
#   - any non-pre_send row (pending_review / already-terminal) → 404 NOT_FOUND
#     (the WHERE guard matches no row), so the confirm is one-shot — no
#     double-contact / double-quota.
# The discriminated-union body (sent | failed+errorMessage) is enforced by
# zValidator BEFORE the service, so a malformed/unsupported status is 400.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). pre_send
# rows are minted via record-with-inquiry (outboundMode=send default, compliant
# tenant). Quota is self-host=unlimited so the 'failed' quota-refund is not
# observable here — the prospect-state consequences (no contact + deferral) are.
# Snapshots + restores tenant compliance. Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-update-outreach-status.sh
#   SKIP_CLEANUP=1 ./e2e/regression-update-outreach-status.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-updstatus-$(date +%s)"
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

pp_status() { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# Mint a pre_send row via record-with-inquiry; echoes the outreachLogId.
mint_presend() {
  local prid="$1"
  api POST /api/outreach/record-with-inquiry \
    "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" '{projectId:$pid, prospectId:$prid, channel:"form", body:"e2e pre_send body"}')"
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

step "set tenant compliance ready + create project (outboundMode=send default)"
api PUT /api/tenant-settings '{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson sent "$(mkseed sent)" --argjson failed "$(mkseed failed)" --argjson nf "$(mkseed notfound)" \
  '{projectId:$pid, prospects:[$sent,$failed,$nf]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_SENT="$(pid_of sent)"; P_FAIL="$(pid_of failed)"; P_NF="$(pid_of notfound)"
[[ -n "$P_SENT" && -n "$P_FAIL" && -n "$P_NF" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: sent=$P_SENT failed=$P_FAIL notfound=$P_NF"

step "mint pre_send rows + a non-pre_send (pending_review) row"
SENT_RESP="$(mint_presend "$P_SENT")"
assert_eq "record-with-inquiry yields pre_send (sent leg)" "$(echo "$SENT_RESP" | jq -r '.status // ""')" "pre_send"
ID_SENT="$(echo "$SENT_RESP" | jq -r '.outreachLogId // ""')"

FAIL_RESP="$(mint_presend "$P_FAIL")"
assert_eq "record-with-inquiry yields pre_send (failed leg)" "$(echo "$FAIL_RESP" | jq -r '.status // ""')" "pre_send"
ID_FAIL="$(echo "$FAIL_RESP" | jq -r '.outreachLogId // ""')"
assert_eq "P_FAIL next_outreach_after NULL pre-confirm" \
  "$(psql_local "SELECT next_outreach_after IS NULL FROM prospects WHERE id=$P_FAIL;")" "t"

DRAFT_RESP="$(api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$P_NF" \
  '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"draft body", status:"pending_review"}')")"
ID_DRAFT="$(echo "$DRAFT_RESP" | jq -r '.id // ""')"
[[ -n "$ID_SENT" && -n "$ID_FAIL" && -n "$ID_DRAFT" ]] || { echo "failed to mint rows: sent=$SENT_RESP fail=$FAIL_RESP draft=$DRAFT_RESP" >&2; exit 1; }
assert_eq "pending_review row created" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$ID_DRAFT;")" "pending_review"
say "ids: ID_SENT=$ID_SENT ID_FAIL=$ID_FAIL ID_DRAFT=$ID_DRAFT"

step "Test 1: pre_send → 'sent' confirm flips prospect to contacted"
CODE="$(api_status PATCH "/api/outreach/$ID_SENT/status" '{"status":"sent"}')"; BODY="$(api_body)"
assert_eq "sent confirm → 200" "$CODE" "200"
assert_eq "body.id echoes row id" "$(echo "$BODY" | jq -r '.id // ""')" "$ID_SENT"
assert_eq "row status='sent'" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$ID_SENT;")" "sent"
assert_eq "row error_message cleared" "$(psql_local "SELECT error_message IS NULL FROM outreach_logs WHERE id=$ID_SENT;")" "t"
assert_eq "prospect flipped new→contacted" "$(pp_status "$P_SENT")" "contacted"

step "Test 2: pre_send → 'failed' confirm defers re-eligibility, does NOT contact"
CODE="$(api_status PATCH "/api/outreach/$ID_FAIL/status" '{"status":"failed","errorMessage":"form submit rejected 500"}')"
assert_eq "failed confirm → 200" "$CODE" "200"
assert_eq "row status='failed'" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$ID_FAIL;")" "failed"
assert_eq "row error_message stamped" "$(psql_local "SELECT error_message FROM outreach_logs WHERE id=$ID_FAIL;")" "form submit rejected 500"
assert_eq "'failed' does NOT contact — prospect stays 'new'" "$(pp_status "$P_FAIL")" "new"
assert_eq "'failed' defers re-eligibility (next_outreach_after stamped)" \
  "$(psql_local "SELECT next_outreach_after IS NOT NULL FROM prospects WHERE id=$P_FAIL;")" "t"

step "Test 3: guard — confirming a non-pre_send (pending_review) row → 404, no mutation"
EXPECTED_404='Outreach not found or not in "pre_send" state'
CODE="$(api_status PATCH "/api/outreach/$ID_DRAFT/status" '{"status":"sent"}')"; BODY="$(api_body)"
assert_eq "confirm pending_review row → 404" "$CODE" "404"
assert_eq "404 body error string" "$(echo "$BODY" | jq -r '.error // ""')" "$EXPECTED_404"
assert_eq "pending_review row NOT mutated" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$ID_DRAFT;")" "pending_review"
assert_eq "P_NF NOT contacted" "$(pp_status "$P_NF")" "new"

step "Test 4: one-shot guard — re-confirming the already-sent row → 404"
CODE="$(api_status PATCH "/api/outreach/$ID_SENT/status" '{"status":"failed","errorMessage":"double confirm"}')"
assert_eq "double-confirm already-sent row → 404" "$CODE" "404"
assert_eq "still 'sent' (not flipped to failed)" "$(psql_local "SELECT status FROM outreach_logs WHERE id=$ID_SENT;")" "sent"

step "Test 5: zValidator rejects unsupported/malformed bodies → 400 (before the WHERE guard)"
CODE="$(api_status PATCH "/api/outreach/$ID_SENT/status" '{"status":"pending_review"}')"
assert_eq "status='pending_review' in confirm body → 400" "$CODE" "400"
CODE="$(api_status PATCH "/api/outreach/$ID_FAIL/status" '{"status":"failed"}')"
assert_eq "status='failed' without errorMessage → 400" "$CODE" "400"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
