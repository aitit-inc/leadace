#!/usr/bin/env bash
# Curl-based regression for the /outreach/send-and-record path:
#   - tenant compliance gate (412 PRECONDITION_FAILED when legal_name /
#     physical_address / default_sender_country is missing)
#   - draft-mode happy path (outboundMode='draft' → status='pending_review',
#     no Gmail required)
#   - send-mode country guardrail (prospect.country='GB' → 422 UNPROCESSABLE,
#     refused before Gmail is touched)
#   - send-mode do-not-contact backstop (prospect.do_not_contact=true → 422
#     UNPROCESSABLE, refused before any outreach_logs row is allocated)
#   - fabricated prospectId → 404 (not a 500 from the outreach_logs FK)
#   - rejection-feedback summary (default scope) → 200 (guards the reserved-
#     keyword "window" SQL regression, which 500s on every call when present)
#   - The Gmail-dependent branch is conditional on local state:
#     - When `sending_identities` has no row for the test tenant, run the
#       412 'Gmail not connected' rollback test (verifies the optimistic
#       INSERT is undone).
#     - When the tenant has Gmail connected AND
#       `E2E_RECIPIENT_OVERRIDE` is set in `backend/.dev.vars`, run the
#       real-send happy path: assert `mode='sent'`, message/thread ids
#       returned, `outreach_logs.status='sent'`, prospect flipped to
#       `contacted`. The recipient override forces the send to a single
#       test mailbox so this never reaches a real prospect.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Mints
# its own JWT via mint-jwt.sh, snapshots the tenant's current compliance
# settings, exercises each branch in a throwaway project, and restores the
# original tenant settings on exit so the developer's local state is not
# clobbered. Never touches `sending_identities` — your Gmail connection
# survives the run.
#
# What this does NOT cover:
#   - record_outreach (the recordOutreach branch — only sendAndRecord here)
#   - Quota enforcement (self-hosted edition is unlimited)
#   - Verification that the test mailbox actually received the email
#     (manual check; this script only asserts the API + DB stamps)
#
# Usage:
#   ./e2e/regression-outbound.sh
#   SKIP_CLEANUP=1 ./e2e/regression-outbound.sh   # leave artifacts
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-outbound-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
DOMAIN_US="$RUN_TAG-us.example"
DOMAIN_GB="$RUN_TAG-gb.example"
DOMAIN_DNC="$RUN_TAG-dnc.example"
EMAIL_US="contact@$DOMAIN_US"
EMAIL_GB="contact@$DOMAIN_GB"
EMAIL_DNC="contact@$DOMAIN_DNC"

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
    curl -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" \
      "$API_URL$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      "$API_URL$path"
  fi
}

# Same call, but emits the HTTP status code on stdout and the response body
# on stderr — the two channels are separated so the caller can assert on the
# exact code (412 vs 422 vs 201, etc.) without relying on body shape alone.
#
# Caller pattern:
#   CODE="$(api_status POST /path "$body" 2>"$tmpfile")"
#   BODY="$(cat "$tmpfile")"
api_status() {
  local method="$1" path="$2" body="${3:-}"
  local tmpfile
  tmpfile="$(mktemp)"
  if [[ -n "$body" ]]; then
    curl -sS -o "$tmpfile" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" \
      "$API_URL$path"
  else
    curl -sS -o "$tmpfile" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      "$API_URL$path"
  fi
  cat "$tmpfile" >&2
  rm -f "$tmpfile"
}

require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }
}

psql_local() {
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"
}

# ---------------------------------------------------------------------------
require_jq
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

# Resolve the tenant id once so we can do direct DB checks (outreach_logs row
# rollback) without trusting anything from the API responses.
USER_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_ID' LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || { echo "no tenant for user $USER_ID — sign in once via the frontend first" >&2; exit 1; }
say "tenant_id=$TENANT_ID user_id=$USER_ID"

# Snapshot the tenant compliance fields so we can restore them at the end.
ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"
ORIG_PRIVACY="$(echo "$ORIGINAL_TENANT" | jq -r '.privacyPolicyUrl // ""')"
say "snapshot: legal='$ORIG_LEGAL' addr='$ORIG_ADDR' country='$ORIG_COUNTRY' privacy='$ORIG_PRIVACY'"

# Always restore + cleanup, even if an assertion failure exits early.
restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2
    echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    echo "Tenant settings were NOT restored. Original snapshot:" >&2
    echo "  legalName='$ORIG_LEGAL' physicalAddress='$ORIG_ADDR' defaultSenderCountry='$ORIG_COUNTRY' privacyPolicyUrl='$ORIG_PRIVACY'" >&2
    exit "$rc"
  fi

  echo "" >&2
  echo "=== teardown ===" >&2

  # Delete project (cascades prospects + outreach_logs links to project).
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi

  # Drop tenant-level orphan organizations / prospects from this run. The
  # project delete cascades the project_prospects link rows but not the
  # tenant-scoped prospect/organization rows themselves; an unrelated tenant
  # has no domain match, so this is safe.
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"

  # Restore tenant compliance settings to the snapshot. Empty captured
  # strings (the field was null in the snapshot) round-trip back to JSON
  # null; non-empty strings are passed through with proper JSON escaping.
  local restore_body
  restore_body="$(jq -nc \
    --arg legal "$ORIG_LEGAL" \
    --arg addr "$ORIG_ADDR" \
    --arg country "$ORIG_COUNTRY" \
    --arg privacy "$ORIG_PRIVACY" \
    '{
      legalName:            (if $legal   == "" then null else $legal   end),
      physicalAddress:      (if $addr    == "" then null else $addr    end),
      defaultSenderCountry: (if $country == "" then null else $country end),
      privacyPolicyUrl:     (if $privacy == "" then null else $privacy end)
    }')"
  api PUT /api/tenant-settings "$restore_body" > /dev/null || true
  say "restored tenant settings"

  exit "$rc"
}
trap restore_and_exit EXIT

# ---------------------------------------------------------------------------
step "clear tenant compliance to test the gate"
CLEAR_RESP="$(api PUT /api/tenant-settings '{"legalName":null,"physicalAddress":null,"defaultSenderCountry":null}')"
assert_eq "tenant.legalName cleared" "$(echo "$CLEAR_RESP" | jq -r '.legalName')" "null"
assert_eq "tenant.physicalAddress cleared" "$(echo "$CLEAR_RESP" | jq -r '.physicalAddress')" "null"
assert_eq "tenant.defaultSenderCountry cleared" "$(echo "$CLEAR_RESP" | jq -r '.defaultSenderCountry')" "null"

step "create test project"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

step "seed prospects (US allowed, GB blocked, DNC do-not-contact)"
SEED_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" \
  --arg dUS "$DOMAIN_US" --arg eUS "$EMAIL_US" \
  --arg dGB "$DOMAIN_GB" --arg eGB "$EMAIL_GB" \
  --arg dDNC "$DOMAIN_DNC" --arg eDNC "$EMAIL_DNC" \
  '{projectId: $pid,
    prospects: [
      {organizationDomain:$dUS, organizationName:"Org US", organizationWebsiteUrl:("https://"+$dUS),
       country:"US", countrySource:"manual",
       name:"Prospect US", overview:"seed US", websiteUrl:("https://"+$dUS+"/about"), email:$eUS, matchReason:"seed"},
      {organizationDomain:$dGB, organizationName:"Org GB", organizationWebsiteUrl:("https://"+$dGB),
       country:"GB", countrySource:"manual",
       name:"Prospect GB", overview:"seed GB", websiteUrl:("https://"+$dGB+"/about"), email:$eGB, matchReason:"seed"},
      {organizationDomain:$dDNC, organizationName:"Org DNC", organizationWebsiteUrl:("https://"+$dDNC),
       country:"US", countrySource:"manual",
       name:"Prospect DNC", overview:"seed DNC", websiteUrl:("https://"+$dDNC+"/about"), email:$eDNC, matchReason:"seed"}
    ]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
SEED_INSERTED="$(echo "$SEED_RESP" | jq -r '.inserted // 0')"
assert_eq "seed inserted=3" "$SEED_INSERTED" "3"

# Resolve prospect ids via the project's prospect listing — the batch
# response only carries insertedIds (no email/country mapping back).
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
PROSPECT_US_ID="$(echo "$LIST_RESP" | jq -r --arg e "$EMAIL_US" '.prospects[]? | select(.email == $e) | .prospectId' | head -1)"
PROSPECT_GB_ID="$(echo "$LIST_RESP" | jq -r --arg e "$EMAIL_GB" '.prospects[]? | select(.email == $e) | .prospectId' | head -1)"
PROSPECT_DNC_ID="$(echo "$LIST_RESP" | jq -r --arg e "$EMAIL_DNC" '.prospects[]? | select(.email == $e) | .prospectId' | head -1)"
[[ -n "$PROSPECT_US_ID" && -n "$PROSPECT_GB_ID" && -n "$PROSPECT_DNC_ID" ]] || {
  echo "could not resolve prospect ids from /projects/$PROJECT_ID/prospects" >&2;
  echo "$LIST_RESP" >&2;
  exit 1;
}
say "prospect_us=$PROSPECT_US_ID prospect_gb=$PROSPECT_GB_ID prospect_dnc=$PROSPECT_DNC_ID"

# ---------------------------------------------------------------------------
# Fabricated prospectId must be a clean 404, not a 500 from the outreach_logs FK.
step "fabricated prospectId returns 404 (not 500)"
BOGUS_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" --arg eUS "$EMAIL_US" \
  '{projectId:$pid, prospectId:999999999, to:[$eUS], subject:"bogus prospect", body:"body"}')"
BOGUS_CODE="$(api_status POST /api/outreach/send-and-record "$BOGUS_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
BOGUS_RESP="$(cat /tmp/regression-outbound-out.$$ 2>/dev/null || true)"; rm -f /tmp/regression-outbound-out.$$
assert_eq "send-and-record bogus prospectId → 404" "$BOGUS_CODE" "404"
[[ "$BOGUS_CODE" == "404" ]] || say "body: $BOGUS_RESP"

# Regression: the recontact query's unquoted "window" alias (reserved keyword) 500'd every call.
step "rejection-feedback summary returns 200 (reserved-keyword SQL regression)"
RFS_CODE="$(api_status GET "/api/projects/$PROJECT_ID/rejection-feedback/summary" 2>/tmp/regression-outbound-out.$$ || true)"
RFS_RESP="$(cat /tmp/regression-outbound-out.$$ 2>/dev/null || true)"; rm -f /tmp/regression-outbound-out.$$
assert_eq "rejection-feedback/summary default scope → 200" "$RFS_CODE" "200"
[[ "$RFS_CODE" == "200" ]] || say "body: $RFS_RESP"

# ---------------------------------------------------------------------------
step "compliance gate: send-and-record returns 412 with missing fields"
GATE_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_US_ID" \
  --arg eUS "$EMAIL_US" \
  '{projectId:$pid, prospectId:$prid, to:[$eUS], subject:"compliance gate test", body:"body"}')"

CODE="$(api_status POST /api/outreach/send-and-record "$GATE_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
GATE_RESP="$(cat /tmp/regression-outbound-out.$$ 2>/dev/null || true)"
rm -f /tmp/regression-outbound-out.$$

assert_eq "gate.http_status" "$CODE" "412"
assert_eq "gate.error" "$(echo "$GATE_RESP" | jq -r '.error // ""')" "Tenant compliance settings incomplete"
# `extra` is spread into the body by respondWithError, so missing[] is at the top level.
GATE_MISSING_SORTED="$(echo "$GATE_RESP" | jq -r '.missing // [] | sort | join(",")')"
assert_eq "gate.missing fields" "$GATE_MISSING_SORTED" "defaultSenderCountry,legalName,physicalAddress"

# ---------------------------------------------------------------------------
step "set compliance + draft mode for happy-path test"
SET_TENANT="$(api PUT /api/tenant-settings "$(jq -nc \
  '{legalName:"E2E Test Corp",
    physicalAddress:"123 Test Lane, Test City, CA 94000",
    defaultSenderCountry:"US"}')")"
assert_eq "tenant.legalName set" "$(echo "$SET_TENANT" | jq -r '.legalName')" "E2E Test Corp"
assert_eq "tenant.defaultSenderCountry set" "$(echo "$SET_TENANT" | jq -r '.defaultSenderCountry')" "US"

SET_SETTINGS="$(api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"draft"}')"
assert_eq "project.outboundMode=draft" "$(echo "$SET_SETTINGS" | jq -r '.outboundMode')" "draft"

# ---------------------------------------------------------------------------
step "draft happy path: outboundMode=draft → mode='drafted'"
DRAFT_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_US_ID" \
  --arg eUS "$EMAIL_US" \
  '{projectId:$pid, prospectId:$prid, to:[$eUS], subject:"draft test", body:"hello from regression"}')"
DRAFT_CODE="$(api_status POST /api/outreach/send-and-record "$DRAFT_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
DRAFT_RESP="$(cat /tmp/regression-outbound-out.$$)"
rm -f /tmp/regression-outbound-out.$$

assert_eq "draft.http_status" "$DRAFT_CODE" "201"
assert_eq "draft.mode" "$(echo "$DRAFT_RESP" | jq -r '.mode // ""')" "drafted"
DRAFT_OUTREACH_ID="$(echo "$DRAFT_RESP" | jq -r '.outreachId // ""')"
[[ -n "$DRAFT_OUTREACH_ID" ]] || { echo "draft response missing outreachId: $DRAFT_RESP" >&2; FAIL=$((FAIL + 1)); }

# DB-side assertion: row exists with status='pending_review'.
DRAFT_STATUS="$(psql_local "SELECT status FROM outreach_logs WHERE id = $DRAFT_OUTREACH_ID;")"
assert_eq "draft.outreach_logs.status" "$DRAFT_STATUS" "pending_review"

# Listing the drafts via the API should surface this row too.
DRAFTS_LIST="$(api GET "/api/projects/$PROJECT_ID/drafts")"
DRAFTS_FOUND="$(echo "$DRAFTS_LIST" | jq --arg id "$DRAFT_OUTREACH_ID" '[.drafts[]? | select(.id == ($id | tonumber))] | length')"
assert_eq "draft visible via /drafts list" "$DRAFTS_FOUND" "1"

# ---------------------------------------------------------------------------
step "send mode + country=GB: 422 country guardrail"
api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"send"}' > /dev/null
GB_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_GB_ID" \
  --arg eGB "$EMAIL_GB" \
  '{projectId:$pid, prospectId:$prid, to:[$eGB], subject:"country test", body:"body"}')"
GB_CODE="$(api_status POST /api/outreach/send-and-record "$GB_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
GB_RESP="$(cat /tmp/regression-outbound-out.$$)"
rm -f /tmp/regression-outbound-out.$$

assert_eq "country_gb.http_status" "$GB_CODE" "422"
assert_eq "country_gb.country (extra)" "$(echo "$GB_RESP" | jq -r '.country // ""')" "GB"
GB_ERROR_OK="$(echo "$GB_RESP" | jq -r '.error // ""' | grep -q '^Recipient country GB is not supported' && echo y || echo n)"
assert_eq "country_gb.error message" "$GB_ERROR_OK" "y"

# No outreach_logs row should have been allocated for the GB prospect (refused
# before the optimistic INSERT).
GB_LOG_COUNT="$(psql_local "SELECT count(*) FROM outreach_logs WHERE prospect_id = $PROSPECT_GB_ID AND project_id = '$PROJECT_ID';")"
assert_eq "country_gb.no log row allocated" "$GB_LOG_COUNT" "0"

# ---------------------------------------------------------------------------
step "send mode + do-not-contact: 422 DNC backstop"
# country=US so the country gate passes and only the DNC backstop can refuse.
psql_local "UPDATE prospects SET do_not_contact = true WHERE id = $PROSPECT_DNC_ID;" > /dev/null
DNC_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_DNC_ID" \
  --arg eDNC "$EMAIL_DNC" \
  '{projectId:$pid, prospectId:$prid, to:[$eDNC], subject:"dnc test", body:"body"}')"
DNC_CODE="$(api_status POST /api/outreach/send-and-record "$DNC_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
DNC_RESP="$(cat /tmp/regression-outbound-out.$$)"
rm -f /tmp/regression-outbound-out.$$

assert_eq "dnc.http_status" "$DNC_CODE" "422"
DNC_ERROR_OK="$(echo "$DNC_RESP" | jq -r '.error // ""' | grep -q '^Prospect is on do-not-contact list' && echo y || echo n)"
assert_eq "dnc.error message" "$DNC_ERROR_OK" "y"

DNC_LOG_COUNT="$(psql_local "SELECT count(*) FROM outreach_logs WHERE prospect_id = $PROSPECT_DNC_ID AND project_id = '$PROJECT_ID';")"
assert_eq "dnc.no log row allocated" "$DNC_LOG_COUNT" "0"

# ---------------------------------------------------------------------------
# Gmail-dependent branch: no-credential rollback OR real-send happy path,
# whichever the local state can cover. Never delete `sending_identities` —
# that wipes the user's connection and the next run can't recover without
# a manual web-UI reconnect.
GMAIL_COUNT="$(psql_local "SELECT count(*) FROM sending_identities WHERE tenant_id = '$TENANT_ID' AND provider='gmail_oauth';")"

if [[ "$GMAIL_COUNT" == "0" ]]; then
  step "send mode + no Gmail credential: 412 'Gmail not connected', row rolled back"

  NO_GMAIL_BODY="$(jq -nc \
    --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_US_ID" \
    --arg eUS "$EMAIL_US" \
    '{projectId:$pid, prospectId:$prid, to:[$eUS], subject:"no gmail test", body:"body"}')"

  PRECOUNT="$(psql_local "SELECT count(*) FROM outreach_logs WHERE prospect_id = $PROSPECT_US_ID AND project_id = '$PROJECT_ID' AND status = 'sent';")"

  NG_CODE="$(api_status POST /api/outreach/send-and-record "$NO_GMAIL_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
  NG_RESP="$(cat /tmp/regression-outbound-out.$$)"
  rm -f /tmp/regression-outbound-out.$$

  assert_eq "no_gmail.http_status" "$NG_CODE" "412"
  assert_eq "no_gmail.error" "$(echo "$NG_RESP" | jq -r '.error // ""')" "Gmail not connected"

  POSTCOUNT="$(psql_local "SELECT count(*) FROM outreach_logs WHERE prospect_id = $PROSPECT_US_ID AND project_id = '$PROJECT_ID' AND status = 'sent';")"
  assert_eq "no_gmail.outreach_logs rolled back" "$POSTCOUNT" "$PRECOUNT"

  echo "" >&2
  echo "  → Skipped real-Gmail happy path (no sending_identities row for this tenant)." >&2
  echo "    Connect Gmail at http://localhost:5173/account-settings and re-run to cover it." >&2
else
  step "send mode + real Gmail: happy path against E2E_RECIPIENT_OVERRIDE"
  GMAIL_EMAIL="$(psql_local "SELECT from_email FROM sending_identities WHERE tenant_id = '$TENANT_ID' AND provider='gmail_oauth' LIMIT 1;")"
  E2E_OVERRIDE="$(grep -E '^E2E_RECIPIENT_OVERRIDE=' "$REPO_ROOT/backend/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"

  if [[ -z "$E2E_OVERRIDE" ]]; then
    say "FAIL: sending_identities present (email=$GMAIL_EMAIL) but E2E_RECIPIENT_OVERRIDE is not set in backend/.dev.vars"
    say "       Real Gmail sends would reach actual recipients. Add the override and restart wrangler dev to enable this test."
    FAIL=$((FAIL + 1))
  else
    say "Gmail connected as $GMAIL_EMAIL; recipient override = $E2E_OVERRIDE"

    SEND_BODY="$(jq -nc \
      --arg pid "$PROJECT_ID" --argjson prid "$PROSPECT_US_ID" \
      --arg eUS "$EMAIL_US" \
      --arg subject "regression-outbound real-send $RUN_TAG" \
      '{projectId:$pid, prospectId:$prid, to:[$eUS], subject:$subject, body:"E2E regression real-send body. Disregard."}')"

    SEND_CODE="$(api_status POST /api/outreach/send-and-record "$SEND_BODY" 2>/tmp/regression-outbound-out.$$ || true)"
    SEND_RESP="$(cat /tmp/regression-outbound-out.$$)"
    rm -f /tmp/regression-outbound-out.$$

    assert_eq "real_send.http_status" "$SEND_CODE" "201"
    assert_eq "real_send.mode" "$(echo "$SEND_RESP" | jq -r '.mode // ""')" "sent"

    SENT_OUTREACH_ID="$(echo "$SEND_RESP" | jq -r '.outreachId // ""')"
    SENT_MESSAGE_ID="$(echo "$SEND_RESP" | jq -r '.messageId // ""')"
    SENT_THREAD_ID="$(echo "$SEND_RESP" | jq -r '.threadId // ""')"

    [[ -n "$SENT_OUTREACH_ID" ]] && PASS=$((PASS + 1)) || { echo "FAIL real_send.outreachId missing in $SEND_RESP" >&2; FAIL=$((FAIL + 1)); }
    [[ -n "$SENT_MESSAGE_ID" ]] && PASS=$((PASS + 1)) || { echo "FAIL real_send.messageId missing in $SEND_RESP" >&2; FAIL=$((FAIL + 1)); }
    [[ -n "$SENT_THREAD_ID" ]]  && PASS=$((PASS + 1)) || { echo "FAIL real_send.threadId missing in $SEND_RESP" >&2; FAIL=$((FAIL + 1)); }

    SENT_STATUS="$(psql_local "SELECT status FROM outreach_logs WHERE id = $SENT_OUTREACH_ID;")"
    assert_eq "real_send.outreach_logs.status=sent" "$SENT_STATUS" "sent"

    PROSPECT_STATUS="$(psql_local "SELECT status FROM project_prospects WHERE prospect_id = $PROSPECT_US_ID AND project_id = '$PROJECT_ID';")"
    assert_eq "real_send.project_prospects.status=contacted" "$PROSPECT_STATUS" "contacted"

    say "Sent via Gmail to $E2E_OVERRIDE (subject: 'regression-outbound real-send $RUN_TAG')."
    say "Verify the test mailbox manually if you want to confirm delivery."
  fi
fi

# ---------------------------------------------------------------------------
step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
