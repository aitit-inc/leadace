#!/usr/bin/env bash
# Regression for sendDraft / markDraftSent preconditions + re-applied
# compliance/country at send time.
#
# A draft composed earlier (clean) MUST be re-checked at send:
#   sendDraft  (POST /outreach/drafts/:id/send, Gmail-backed email path) rejects
#     not-found(404) / non-pending(409) / channel!=email(422) / no-email(422) /
#     DNC(422), then RE-enforces compliance(412) + country(422) before the Gmail
#     call; on Gmail success flips row 'sent' + prospect 'contacted'.
#   markDraftSent (POST /outreach/drafts/:id/mark-sent, out-of-band form/SNS path,
#     NO Gmail) rejects not-found(404) / non-pending(409) / channel==email(422) /
#     DNC(422), RE-enforces compliance(412) + country(422), then flips row 'sent'
#     + prospect 'contacted'.
# Every rejection leg asserts the row is UNCHANGED (still pending_review, prospect
# still 'new') — the DB-state assert, not the HTTP code, is what catches a dropped
# guard that flips the row anyway.
#
# Runs against the local stack. The ONLY Gmail-dependent leg is the sendDraft 200
# happy path: gated on sending_identities + E2E_RECIPIENT_OVERRIDE exactly like
# regression-outbound.sh — when Gmail is absent it runs the 412 'Gmail not
# connected' leg instead (row stays pending_review). markDraftSent's happy path
# needs no Gmail and is the always-on row-sent+contacted assertion. Quota legs
# are not testable (self-host=unlimited). Snapshots+restores tenant compliance.
#
# Usage:
#   ./e2e/regression-draft-send.sh
#   SKIP_CLEANUP=1 ./e2e/regression-draft-send.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-draftsend-$(date +%s)"
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

log_status() { psql_local "SELECT status FROM outreach_logs WHERE id=$1;"; }
pp_status()  { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }
noa_set()    { psql_local "SELECT next_outreach_after IS NOT NULL FROM prospects WHERE id=$1;"; }

COMPLY_READY='{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}'
COMPLY_CLEAR='{"legalName":null,"physicalAddress":null,"defaultSenderCountry":null}'

mkseed() {
  local tag="$1" country="$2"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg c "$country" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:$c, countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}


# email draft via send-and-record (draft mode → pending_review channel=email)
mk_email_draft() { api POST /api/outreach/send-and-record \
  "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" --arg to "$2" '{projectId:$pid, prospectId:$prid, to:[$to], subject:"e2e draft", body:"e2e email draft body"}')" \
  | jq -r '.outreachId // ""'; }
# form draft via record-with-inquiry (draft mode → pending_review channel=form)
mk_form_draft() { api POST /api/outreach/record-with-inquiry \
  "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" '{projectId:$pid, prospectId:$prid, channel:"form", body:"e2e form draft"}')" \
  | jq -r '.outreachLogId // ""'; }

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
  # Delete prospects by org domain (the noemail prospect's email is nulled mid-test,
  # so the email-LIKE filter used elsewhere would miss it and orphan the row).
  psql_local "DELETE FROM prospects WHERE tenant_id='$TENANT_ID' AND organization_id IN (SELECT id FROM organizations WHERE tenant_id='$TENANT_ID' AND domain LIKE '$RUN_TAG-%');" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "compliance ready + project (draft mode) + seed 5 prospects"
api PUT /api/tenant-settings "$COMPLY_READY" > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
assert_eq "project outboundMode=draft" "$(api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"draft"}' | jq -r '.outboundMode')" "draft"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson uss "$(mkseed ussend US)" --argjson usm "$(mkseed usmark US)" \
  --argjson gb "$(mkseed gb GB)" --argjson dnc "$(mkseed dnc US)" --argjson noe "$(mkseed noemail US)" \
  --argjson dead "$(mkseed dead US)" \
  '{projectId:$pid, prospects:[$uss,$usm,$gb,$dnc,$noe,$dead]}')"
assert_eq "seed inserted=6" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "6"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_USS="$(pid_of ussend)"; P_USM="$(pid_of usmark)"; P_GB="$(pid_of gb)"; P_DNC="$(pid_of dnc)"; P_NOE="$(pid_of noemail)"; P_DEAD="$(pid_of dead)"
[[ -n "$P_USS" && -n "$P_USM" && -n "$P_GB" && -n "$P_DNC" && -n "$P_NOE" && -n "$P_DEAD" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
say "ids: ussend=$P_USS usmark=$P_USM gb=$P_GB dnc=$P_DNC noemail=$P_NOE dead=$P_DEAD"

step "create drafts (email via send-and-record; form via record-with-inquiry) while compliant"
D_SEND="$(mk_email_draft "$P_USS" "contact@$RUN_TAG-ussend.example")"
D_GB="$(mk_email_draft "$P_GB" "contact@$RUN_TAG-gb.example")"
D_DNC="$(mk_email_draft "$P_DNC" "contact@$RUN_TAG-dnc.example")"
D_NOE="$(mk_email_draft "$P_NOE" "contact@$RUN_TAG-noemail.example")"
D_DEAD="$(mk_email_draft "$P_DEAD" "contact@$RUN_TAG-dead.example")"
F_MARK="$(mk_form_draft "$P_USM")"
F_GB="$(mk_form_draft "$P_GB")"
F_DNC="$(mk_form_draft "$P_DNC")"
for v in D_SEND D_GB D_DNC D_NOE D_DEAD F_MARK F_GB F_DNC; do [[ -n "${!v}" ]] || { echo "failed to create draft $v" >&2; exit 1; }; done
say "email: D_SEND=$D_SEND D_GB=$D_GB D_DNC=$D_DNC D_NOE=$D_NOE D_DEAD=$D_DEAD | form: F_MARK=$F_MARK F_GB=$F_GB F_DNC=$F_DNC"
psql_local "UPDATE prospects SET email=NULL WHERE id=$P_NOE;" > /dev/null
psql_local "UPDATE prospects SET do_not_contact=true WHERE id=$P_DNC;" > /dev/null
# Draft composed while deliverability was 'unknown'; stamp 'undeliverable' so
# sendDraft's send-time backstop (added with the deliverability-gate fix) fires.
psql_local "UPDATE prospects SET email_deliverability='undeliverable' WHERE id=$P_DEAD;" > /dev/null
say "nulled noemail email, flagged dnc do_not_contact, stamped dead undeliverable"

step "sendDraft rejection legs (all fire BEFORE the Gmail call; row stays pending_review)"
assert_eq "sendDraft not-found → 404" "$(api_status POST /api/outreach/drafts/999999999/send)" "404"
assert_eq "  404 error" "$(api_body | jq -r '.error // ""')" "Draft not found"

CODE="$(api_status POST "/api/outreach/drafts/$F_DNC/send")"
assert_eq "sendDraft channel=form → 422 use mark-sent" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "This draft is not an email — use mark-sent instead"
assert_eq "  F_DNC row untouched" "$(log_status "$F_DNC")" "pending_review"

CODE="$(api_status POST "/api/outreach/drafts/$D_NOE/send")"
assert_eq "sendDraft no-email → 422" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Prospect has no email address"
assert_eq "  D_NOE row untouched" "$(log_status "$D_NOE")" "pending_review"

CODE="$(api_status POST "/api/outreach/drafts/$D_DNC/send")"
assert_eq "sendDraft DNC → 422" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Prospect is on do-not-contact list"
assert_eq "  D_DNC row untouched, P_DNC not contacted" "$(log_status "$D_DNC")/$(pp_status "$P_DNC")" "pending_review/new"

CODE="$(api_status POST "/api/outreach/drafts/$D_DEAD/send")"
assert_eq "sendDraft undeliverable → 422" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Recipient email domain cannot receive mail (DNS-confirmed undeliverable)"
assert_eq "  D_DEAD row untouched, P_DEAD not contacted" "$(log_status "$D_DEAD")/$(pp_status "$P_DEAD")" "pending_review/new"

step "sendDraft re-enforces compliance + country at send time"
api PUT /api/tenant-settings "$COMPLY_CLEAR" > /dev/null
CODE="$(api_status POST "/api/outreach/drafts/$D_SEND/send")"
assert_eq "sendDraft compliance incomplete → 412" "$CODE" "412"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Tenant compliance settings incomplete"
assert_eq "  D_SEND untouched, P_USS not contacted" "$(log_status "$D_SEND")/$(pp_status "$P_USS")" "pending_review/new"
api PUT /api/tenant-settings "$COMPLY_READY" > /dev/null
CODE="$(api_status POST "/api/outreach/drafts/$D_GB/send")"; BODY="$(api_body)"
assert_eq "sendDraft unsupported country → 422" "$CODE" "422"
assert_eq "  country in error" "$(echo "$BODY" | jq -r '.error // ""' | grep -qi 'not supported' && echo y || echo n)" "y"
assert_eq "  body.country=GB" "$(echo "$BODY" | jq -r '.country // ""')" "GB"
assert_eq "  D_GB untouched, P_GB not contacted" "$(log_status "$D_GB")/$(pp_status "$P_GB")" "pending_review/new"

step "sendDraft Gmail leg (gated on sending_identities + E2E_RECIPIENT_OVERRIDE)"
GMAIL_COUNT="$(psql_local "SELECT count(*) FROM sending_identities WHERE tenant_id = '$TENANT_ID' AND provider='gmail_oauth';")"
if [[ "$GMAIL_COUNT" == "0" ]]; then
  CODE="$(api_status POST "/api/outreach/drafts/$D_SEND/send")"
  assert_eq "sendDraft (no Gmail) → 412 'Gmail not connected'" "$CODE" "412"
  assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Gmail not connected"
  assert_eq "  D_SEND stays pending_review (no row flip), P_USS still new" "$(log_status "$D_SEND")/$(pp_status "$P_USS")" "pending_review/new"
  say "→ Skipped real-Gmail happy path (no sending_identities row for this tenant)."
else
  E2E_OVERRIDE="$(grep -E '^E2E_RECIPIENT_OVERRIDE=' "$REPO_ROOT/backend/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
  if [[ -z "$E2E_OVERRIDE" ]]; then
    say "FAIL: sending_identities present but E2E_RECIPIENT_OVERRIDE not set in backend/.dev.vars"
    FAIL=$((FAIL + 1))
  else
    CODE="$(api_status POST "/api/outreach/drafts/$D_SEND/send")"; BODY="$(api_body)"
    assert_eq "sendDraft (real Gmail) → 200" "$CODE" "200"
    assert_eq "  mode=sent" "$(echo "$BODY" | jq -r '.mode // ""')" "sent"
    assert_eq "  D_SEND flipped to sent, P_USS contacted" "$(log_status "$D_SEND")/$(pp_status "$P_USS")" "sent/contacted"
    assert_eq "  P_USS next_outreach_after stamped" "$(noa_set "$P_USS")" "t"
    say "→ Sent via Gmail to $E2E_OVERRIDE (sendDraft happy path)."
  fi
fi

step "sendDraft one-shot guard: a non-pending row → 409"
psql_local "UPDATE outreach_logs SET status='sent' WHERE id=$D_SEND;" > /dev/null
CODE="$(api_status POST "/api/outreach/drafts/$D_SEND/send")"
assert_eq "sendDraft already-sent → 409" "$CODE" "409"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Draft already sent or not in review"

step "markDraftSent rejection legs (no Gmail; row stays pending_review)"
assert_eq "markDraftSent not-found → 404" "$(api_status POST /api/outreach/drafts/999999999/mark-sent)" "404"

CODE="$(api_status POST "/api/outreach/drafts/$D_DNC/mark-sent")"
assert_eq "markDraftSent channel=email → 422" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Email drafts must be sent via /send, not mark-sent"
assert_eq "  D_DNC untouched" "$(log_status "$D_DNC")" "pending_review"

CODE="$(api_status POST "/api/outreach/drafts/$F_DNC/mark-sent")"
assert_eq "markDraftSent DNC → 422" "$CODE" "422"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Prospect is on do-not-contact list"
assert_eq "  F_DNC untouched, P_DNC not contacted" "$(log_status "$F_DNC")/$(pp_status "$P_DNC")" "pending_review/new"

step "markDraftSent re-enforces compliance + country at confirm time"
api PUT /api/tenant-settings "$COMPLY_CLEAR" > /dev/null
CODE="$(api_status POST "/api/outreach/drafts/$F_MARK/mark-sent")"
assert_eq "markDraftSent compliance incomplete → 412" "$CODE" "412"
assert_eq "  F_MARK untouched, P_USM not contacted" "$(log_status "$F_MARK")/$(pp_status "$P_USM")" "pending_review/new"
api PUT /api/tenant-settings "$COMPLY_READY" > /dev/null
CODE="$(api_status POST "/api/outreach/drafts/$F_GB/mark-sent")"; BODY="$(api_body)"
assert_eq "markDraftSent unsupported country → 422" "$CODE" "422"
assert_eq "  body.country=GB" "$(echo "$BODY" | jq -r '.country // ""')" "GB"
assert_eq "  F_GB untouched, P_GB not contacted" "$(log_status "$F_GB")/$(pp_status "$P_GB")" "pending_review/new"

step "markDraftSent happy path (form/US/compliant, NO Gmail) → 200, sent + contacted"
CODE="$(api_status POST "/api/outreach/drafts/$F_MARK/mark-sent")"; BODY="$(api_body)"
assert_eq "markDraftSent happy → 200" "$CODE" "200"
assert_eq "  outreachId echoed" "$(echo "$BODY" | jq -r '.outreachId // ""')" "$F_MARK"
assert_eq "  F_MARK flipped to sent, P_USM contacted" "$(log_status "$F_MARK")/$(pp_status "$P_USM")" "sent/contacted"
assert_eq "  P_USM next_outreach_after stamped" "$(noa_set "$P_USM")" "t"

step "markDraftSent one-shot guard: re-mark already-sent → 409"
CODE="$(api_status POST "/api/outreach/drafts/$F_MARK/mark-sent")"
assert_eq "markDraftSent already-sent → 409" "$CODE" "409"
assert_eq "  error" "$(api_body | jq -r '.error // ""')" "Draft already sent or not in review"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
