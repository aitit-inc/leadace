#!/usr/bin/env bash
# Net-new regression for the CSV import one-way do-not-contact ratchet
# (coverage-audit §2 gap #5). A stale CSV re-imported with doNotContact
# omitted/false must NEVER clear an existing opt-out — a CAN-SPAM/CASL leak.
#
# Two layers enforce this (the live behavior is stronger than the audit's
# one-line framing, which only named the second):
#   - PRIMARY: resolveDedup (prospect-dedup.ts:63) maps an existing-DNC email
#     match to a `do_not_contact` skip regardless of dedupPolicy — the row is
#     never touched, so the flag can't be cleared and the overwrite path is
#     never even reached for a DNC prospect.
#   - SECONDARY: for a NON-DNC existing row that IS overwritten, prospectUpdateSet
#     sets doNotContact only when the incoming row is explicitly true; omitted /
#     false is a no-op (can raise the flag, never lower it).
#
# Covers, against the local stack (localhost:8787 API + 54322 Postgres),
# tenant-only imports (no projectId, so no matchReason needed) deduped by email:
#
#   1. fresh import with doNotContact=1  → do_not_contact=true
#   2. re-import (overwrite) of the DNC prospect, DNC OMITTED  → skipped
#      (reason do_not_contact), row untouched, flag stays true
#   3. re-import (overwrite) of the DNC prospect, doNotContact=0 explicit  → same
#   4. fresh import of a clean prospect (DNC=0)  → do_not_contact=false
#   5. overwrite the clean prospect, DNC omitted  → row IS updated (overview
#      bumped), flag stays false (prospectUpdateSet no-op on omit)
#   6. overwrite the clean prospect with doNotContact=1  → flag flips true
#      (one-way ratchet UP)
#   7. once it is DNC, overwrite with doNotContact=0  → skipped do_not_contact,
#      stays true (the prospect has crossed into the protected set)
#
# Curl-only, no Claude session, no Anthropic budget. Cleans up on exit.
#
# Usage:
#   ./e2e/regression-import-dnc.sh
#   SKIP_CLEANUP=1 ./e2e/regression-import-dnc.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-importdnc-$(date +%s)"

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

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

# POST a CSV import. $1 = csvText, $2 = dedupPolicy. No projectId (tenant-only).
import_csv() {
  local csv="$1" policy="$2"
  api POST /api/prospects/import "$(jq -nc --arg c "$csv" --arg p "$policy" '{csvText:$c, dedupPolicy:$p}')"
}

# Build a one-row CSV. $1=tag (→domain/email), $2=overview, $3=dnc cell value
# ('' => omit the doNotContact column entirely).
mkcsv() {
  local tag="$1" overview="$2" dnc="$3"
  local dom="$RUN_TAG-$tag.example" email="contact@$RUN_TAG-$tag.example"
  if [[ -n "$dnc" ]]; then
    printf 'organizationDomain,organizationName,organizationWebsiteUrl,name,overview,websiteUrl,email,doNotContact\n%s,Org,https://%s,Alice,%s,https://%s/about,%s,%s\n' \
      "$dom" "$dom" "$overview" "$dom" "$email" "$dnc"
  else
    printf 'organizationDomain,organizationName,organizationWebsiteUrl,name,overview,websiteUrl,email\n%s,Org,https://%s,Alice,%s,https://%s/about,%s\n' \
      "$dom" "$dom" "$overview" "$dom" "$email"
  fi
}

dnc_of() { psql_local "SELECT do_not_contact FROM prospects WHERE tenant_id='$TENANT_ID' AND email='contact@$RUN_TAG-$1.example';"; }
overview_of() { psql_local "SELECT overview FROM prospects WHERE tenant_id='$TENANT_ID' AND email='contact@$RUN_TAG-$1.example';"; }
# First skip reason in skippedDetails[], or '-' when none.
skip_reason() { echo "$1" | jq -r '(.skippedDetails // [])[0].reason // "-"'; }

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
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving run-tagged rows in place." >&2; exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "Test 1: fresh import with doNotContact=1 sets do_not_contact=true"
R1="$(import_csv "$(mkcsv dnc overview-v1 1)" skip)"
assert_eq "import1 inserted=1"        "$(echo "$R1" | jq -r '.inserted // 0')" "1"
assert_eq "DNC prospect do_not_contact=t" "$(dnc_of dnc)" "t"

step "Test 2: overwrite of a DNC prospect, DNC OMITTED → skipped, row untouched"
R2="$(import_csv "$(mkcsv dnc overview-v2 '')" overwrite)"
assert_eq "import2 skipped reason=do_not_contact" "$(skip_reason "$R2")" "do_not_contact"
assert_eq "import2 overwritten=0 (never reached overwrite path)" "$(echo "$R2" | jq -r '.overwritten // 0')" "0"
assert_eq "overview UNCHANGED (row not touched)" "$(overview_of dnc)" "overview-v1"
assert_eq "do_not_contact STILL true" "$(dnc_of dnc)" "t"

step "Test 3: overwrite of a DNC prospect, doNotContact=0 explicit → still skipped"
R3="$(import_csv "$(mkcsv dnc overview-v3 0)" overwrite)"
assert_eq "import3 skipped reason=do_not_contact" "$(skip_reason "$R3")" "do_not_contact"
assert_eq "overview STILL unchanged"  "$(overview_of dnc)" "overview-v1"
assert_eq "do_not_contact STILL true (explicit false cannot clear)" "$(dnc_of dnc)" "t"

step "Test 4: fresh import of a clean prospect (DNC=0) → do_not_contact=false"
R4="$(import_csv "$(mkcsv clean overview-c1 0)" skip)"
assert_eq "import4 inserted=1"        "$(echo "$R4" | jq -r '.inserted // 0')" "1"
assert_eq "clean prospect do_not_contact=f" "$(dnc_of clean)" "f"

step "Test 5: overwrite the clean prospect, DNC omitted → updated, flag stays false"
R5="$(import_csv "$(mkcsv clean overview-c2 '')" overwrite)"
assert_eq "import5 overwritten=1"     "$(echo "$R5" | jq -r '.overwritten // 0')" "1"
assert_eq "overview updated → overwrite path ran" "$(overview_of clean)" "overview-c2"
assert_eq "do_not_contact stays false (omit = no-op)" "$(dnc_of clean)" "f"

step "Test 6: overwrite the clean prospect with doNotContact=1 → ratchets UP"
R6="$(import_csv "$(mkcsv clean overview-c3 1)" overwrite)"
assert_eq "import6 overwritten=1"     "$(echo "$R6" | jq -r '.overwritten // 0')" "1"
assert_eq "do_not_contact flips to true (one-way ratchet UP)" "$(dnc_of clean)" "t"

step "Test 7: now-DNC prospect, overwrite with doNotContact=0 → skipped, stays true"
R7="$(import_csv "$(mkcsv clean overview-c4 0)" overwrite)"
assert_eq "import7 skipped reason=do_not_contact" "$(skip_reason "$R7")" "do_not_contact"
assert_eq "overview unchanged at c3 (now protected)" "$(overview_of clean)" "overview-c3"
assert_eq "do_not_contact STILL true" "$(dnc_of clean)" "t"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
