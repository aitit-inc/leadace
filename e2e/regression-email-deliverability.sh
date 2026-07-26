#!/usr/bin/env bash
# Regression for the email-deliverability gate (DNS-only, invalid-only).
# Covers the two server-side behaviors the gate adds, decoupled from real DNS so
# the test is deterministic (the DoH parsing itself is unit-tested in
# backend/src/domain/email-deliverability.test.ts):
#
#   1. listReachable email gate — GET /projects/:id/prospects/reachable excludes a
#      prospect whose email is 'undeliverable' from the email channel, keeps one
#      whose verdict is 'unknown', and reclassifies an undeliverable-email prospect
#      that still has a contactFormUrl into the form channel (byChannel.email and
#      byChannel.formOnly both agree).
#
#   2. send-and-record gate — POST /outreach/send-and-record returns 422 for an
#      'undeliverable' recipient, consuming no quota and writing no 'sent' row.
#
# Verdicts are set directly via psql (UPDATE prospects.email_deliverability) so the
# test does not depend on what the registration-time DoH check returns for the seed
# domains — that path (DoH → verdict) is covered by the unit suite. The stored
# verdict short-circuits the send-time re-check and the seed domains are .example,
# which it skips, so this suite stays offline.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Mints its own
# JWT, creates a throwaway project, and cleans up on exit (including any tenant
# compliance fields it had to set for the send path). Curl-only, no Claude session.
#
# Usage:
#   ./e2e/regression-email-deliverability.sh
#   SKIP_CLEANUP=1 ./e2e/regression-email-deliverability.sh
#
# Exit status: 0 all passed · 1 setup/HTTP failure · 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-deliv-$(date +%s)"
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
    printf '  FAIL %s\n       want: %s\n       got:  %s\n' "$label" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
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

api_status() {
  local method="$1" path="$2" body="${3:-}" tmpfile
  tmpfile="$(mktemp)"
  if [[ -n "$body" ]]; then
    curl -sS -o "$tmpfile" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o "$tmpfile" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
  cat "$tmpfile" >&2; rm -f "$tmpfile"
}

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

reachable_has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
}

# One US, email-only /prospects/batch element (country US so the hard country gate
# admits it; email is the only channel so the deliverability gate is decisive).
mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

# Same as mkseed but also carries a contactFormUrl, so when its email is marked
# 'undeliverable' the prospect still has a (form) channel — exercising the
# email -> formOnly reclassification in listReachable's byChannel summary.
mkseed_form() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e,
      contactFormUrl:("https://"+$d+"/contact"), matchReason:"seed"}'
}

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

# Capture tenant compliance so we can restore it (the send path 412s without it,
# before reaching the deliverability gate, so Test 2 sets it temporarily).
ORIG_LEGAL="$(psql_local "SELECT COALESCE(legal_name,'') FROM tenants WHERE id='$TENANT_ID';")"
ORIG_ADDR="$(psql_local "SELECT COALESCE(physical_address,'') FROM tenants WHERE id='$TENANT_ID';")"
ORIG_COUNTRY="$(psql_local "SELECT COALESCE(default_sender_country,'') FROM tenants WHERE id='$TENANT_ID';")"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and tagged rows." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true; say "deleted project $PROJECT_ID"; fi
  psql_local "DELETE FROM outreach_logs WHERE tenant_id='$TENANT_ID' AND project_id='${PROJECT_ID:-}';" > /dev/null 2>&1 || true
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  psql_local "UPDATE tenants SET
    legal_name = NULLIF('$ORIG_LEGAL',''),
    physical_address = NULLIF('$ORIG_ADDR',''),
    default_sender_country = NULLIF('$ORIG_COUNTRY','')
    WHERE id='$TENANT_ID';" > /dev/null || true
  say "dropped tagged rows + restored tenant compliance"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed three US prospects (good email / dead email / dead email+form)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson good "$(mkseed good)" --argjson dead "$(mkseed dead)" \
  --argjson deadform "$(mkseed_form deadform)" \
  '{projectId:$pid, prospects:[$good,$dead,$deadform]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
GOOD_ID="$(pid_of good)"; DEAD_ID="$(pid_of dead)"; DEADFORM_ID="$(pid_of deadform)"
[[ -n "$GOOD_ID" && -n "$DEAD_ID" && -n "$DEADFORM_ID" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: good=$GOOD_ID dead=$DEAD_ID deadform=$DEADFORM_ID"

psql_local "UPDATE prospects SET email_deliverability='unknown'       WHERE id=$GOOD_ID AND tenant_id='$TENANT_ID';" > /dev/null
psql_local "UPDATE prospects SET email_deliverability='undeliverable' WHERE id IN ($DEAD_ID,$DEADFORM_ID) AND tenant_id='$TENANT_ID';" > /dev/null
assert_eq "good verdict=unknown"           "$(psql_local "SELECT email_deliverability FROM prospects WHERE id=$GOOD_ID;")" "unknown"
assert_eq "dead verdict=undeliverable"     "$(psql_local "SELECT email_deliverability FROM prospects WHERE id=$DEAD_ID;")" "undeliverable"
assert_eq "deadform verdict=undeliverable" "$(psql_local "SELECT email_deliverability FROM prospects WHERE id=$DEADFORM_ID;")" "undeliverable"

step "Test 1: listReachable drops the undeliverable email, keeps unknown, reclassifies email+form into formOnly"
R1="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "reachable.good present"                "$(reachable_has "$R1" "$GOOD_ID")"     "y"
assert_eq "reachable.dead excluded"               "$(reachable_has "$R1" "$DEAD_ID")"     "n"
assert_eq "reachable.deadform present (via form)" "$(reachable_has "$R1" "$DEADFORM_ID")" "y"
assert_eq "reachable.total=2"                     "$(echo "$R1" | jq -r '.total')"        "2"
assert_eq "byChannel.email=1 (dead/deadform emails not counted)" "$(echo "$R1" | jq -r '.byChannel.email')" "1"
assert_eq "byChannel.formOnly=1 (deadform reclassified to form)" "$(echo "$R1" | jq -r '.byChannel.formOnly')" "1"

step "Test 2: send-and-record 422s the undeliverable recipient (no quota, no sent row)"
# The send path 412s without tenant compliance (before the deliverability gate),
# so set it temporarily; teardown restores the originals.
psql_local "UPDATE tenants SET legal_name='E2E Deliverability', physical_address='123 Test St', default_sender_country='US' WHERE id='$TENANT_ID';" > /dev/null

SENT_BEFORE="$(psql_local "SELECT COUNT(*) FROM outreach_logs WHERE tenant_id='$TENANT_ID' AND status='sent';")"
SEND_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$DEAD_ID" \
  '{projectId:$pid, prospectId:$prid, to:["contact@'"$RUN_TAG"'-dead.example"], subject:"e2e", body:"e2e body"}')"
SEND_CODE="$(api_status POST /api/outreach/send-and-record "$SEND_BODY" 2>/tmp/regression-deliv-out.$$ || true)"
SEND_RESP="$(cat /tmp/regression-deliv-out.$$)"; rm -f /tmp/regression-deliv-out.$$
assert_eq "send.http_status=422" "$SEND_CODE" "422"
assert_eq "send.error mentions deliverability" \
  "$(echo "$SEND_RESP" | jq -r '.error // ""' | grep -iqE 'deliver|receive mail' && echo y || echo n)" "y"
SENT_AFTER="$(psql_local "SELECT COUNT(*) FROM outreach_logs WHERE tenant_id='$TENANT_ID' AND status='sent';")"
assert_eq "no 'sent' row written (quota untouched)" "$SENT_AFTER" "$SENT_BEFORE"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
[[ "$FAIL" -gt 0 ]] && exit 2
exit 0
