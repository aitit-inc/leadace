#!/usr/bin/env bash
# Regression for decision-maker-pointer derivation.
#
# record_response with a rejectionFeedback.decision_maker_pointer can derive a
# referred prospect (derivePointerProspect, services/responses.ts). The
# guarded branches under test:
#   A no-create-when-referrer-DNC — if the referrer's own rejection forces DNC
#     (unsubscribe_request / consent / never), derivation is suppressed entirely.
#   B email dedup FILL-MISSING-ONLY — a pointer email matching an existing
#     prospect fills only null contactName/department; populated fields are never
#     overwritten (matched_existing).
#   C existing-DNC pointer match → no-op (a DNC prospect is left untouched).
#   D self-reference skip — pointer email or name == the referrer's → no row.
#   E/F cross-tenant isolation + create-new — a same-email prospect under a
#     DIFFERENT tenant is invisible to the dedup, so a NEW prospect is created in
#     the caller's tenant, inheriting the referrer's org + project links.
#
# Uses pending_review outreach drafts (no send gates / no compliance) +
# record_response (no quota). The foreign-tenant row is a direct psql INSERT
# (the local stack has one auth user). Curl-only, cleans up (incl. the derived
# prospect, which is tenant-scoped and not cascaded by project delete).
#
# Usage:
#   ./e2e/regression-decision-maker-pointer.sh
#   SKIP_CLEANUP=1 ./e2e/regression-decision-maker-pointer.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-dmptr-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
FOREIGN_TENANT="$RUN_TAG-foreign"

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
psql_local()  { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }
psql_val()    { psql_local "$1" | head -1; }  # first line only (skips the INSERT status tag)

prospect_count_email() { psql_local "SELECT COUNT(*)::int FROM prospects WHERE tenant_id='$TENANT_ID' AND email='$1';"; }

mkseed() {
  local tag="$1" cname="${2:-}"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" --arg cn "$cname" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}
     + (if $cn=="" then {} else {contactName:$cn} end)'
}

# pending_review draft for a referrer prospect; echoes the outreachLogId.
olog_of() { api POST /api/outreach \
  "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"e2e draft", status:"pending_review"}')" \
  | jq -r '.id // ""'; }

# record_response with a decision_maker_pointer. $1=logId $2=primary_reason $3=pointer-json
ptr_resp() { jq -nc --argjson lid "$1" --arg r "$2" --argjson ptr "$3" \
  '{outreachLogId:$lid, channel:"email", content:"e2e referral", sentiment:"negative", responseType:"rejection",
    rejectionFeedback:{version:1, primary_reason:$r, submitted_at:(now|todateiso8601), decision_maker_pointer:$ptr}}'; }

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
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>}, derived rows, and foreign tenant in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  # Derived prospects carry pointer emails tagged with RUN_TAG (dm-*@$RUN_TAG.example);
  # match both the seeded (contact@$RUN_TAG-*) and derived (%$RUN_TAG%) rows.
  psql_local "DELETE FROM prospects WHERE tenant_id='$TENANT_ID' AND (email LIKE 'contact@$RUN_TAG-%' OR email LIKE '%$RUN_TAG%');" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id='$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM prospects WHERE tenant_id='$FOREIGN_TENANT';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id='$FOREIGN_TENANT';" > /dev/null || true
  psql_local "DELETE FROM tenants WHERE id='$FOREIGN_TENANT';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG + foreign tenant"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed referrer/target prospects"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson rdnc "$(mkseed rdnc)" --argjson rfill "$(mkseed rfill)" --argjson target "$(mkseed target)" \
  --argjson rself "$(mkseed rself 'Jane Self')" --argjson rdnctgt "$(mkseed rdnctgt)" \
  --argjson dnctgt "$(mkseed dnctgt)" --argjson rxt "$(mkseed rxt)" \
  '{projectId:$pid, prospects:[$rdnc,$rfill,$target,$rself,$rdnctgt,$dnctgt,$rxt]}')"
assert_eq "seed inserted=7" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "7"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_RDNC="$(pid_of rdnc)"; P_RFILL="$(pid_of rfill)"; P_TARGET="$(pid_of target)"; P_RSELF="$(pid_of rself)"
P_RDNCTGT="$(pid_of rdnctgt)"; P_DNCTGT="$(pid_of dnctgt)"; P_RXT="$(pid_of rxt)"
for v in P_RDNC P_RFILL P_TARGET P_RSELF P_RDNCTGT P_DNCTGT P_RXT; do [[ -n "${!v}" ]] || { echo "could not resolve $v" >&2; exit 1; }; done
psql_local "UPDATE prospects SET do_not_contact=true WHERE id=$P_DNCTGT;" > /dev/null
say "resolved 7 prospects; flagged dnctgt DNC"

step "create foreign-tenant same-email prospect (cross-tenant isolation fixture)"
psql_local "INSERT INTO tenants(id,name) VALUES('$FOREIGN_TENANT','E2E Foreign') ON CONFLICT DO NOTHING;" > /dev/null
FOREIGN_ORG="$(psql_val "INSERT INTO organizations(tenant_id,domain,name,website_url) VALUES('$FOREIGN_TENANT','$RUN_TAG-foreign.example','Foreign Org','https://$RUN_TAG-foreign.example') RETURNING id;")"
FOREIGN_PROSPECT_ID="$(psql_val "INSERT INTO prospects(tenant_id,name,organization_id,overview,website_url,email,do_not_contact) VALUES('$FOREIGN_TENANT','Foreign DM',$FOREIGN_ORG,'foreign overview','https://$RUN_TAG-foreign.example/about','dm-xt@$RUN_TAG.example',false) RETURNING id;")"
[[ -n "$FOREIGN_ORG" && -n "$FOREIGN_PROSPECT_ID" ]] || { echo "failed to create foreign fixture" >&2; exit 1; }
say "foreign: org=$FOREIGN_ORG prospect=$FOREIGN_PROSPECT_ID"

step "create one pending_review draft per referrer"
OL_DNC="$(olog_of "$P_RDNC")"; OL_FILL="$(olog_of "$P_RFILL")"; OL_FILL2="$(olog_of "$P_RFILL")"
OL_SELF="$(olog_of "$P_RSELF")"; OL_SELF2="$(olog_of "$P_RSELF")"; OL_DNCTGT="$(olog_of "$P_RDNCTGT")"; OL_XT="$(olog_of "$P_RXT")"
for v in OL_DNC OL_FILL OL_FILL2 OL_SELF OL_SELF2 OL_DNCTGT OL_XT; do [[ -n "${!v}" ]] || { echo "failed to create draft $v" >&2; exit 1; }; done

step "Branch A: referrer-DNC suppresses derivation entirely"
PTR="$(jq -nc --arg t "$RUN_TAG" '{name:"New DM A", email:("dm-a@"+$t+".example"), role:"CTO"}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_DNC" unsubscribe_request "$PTR")")"; BODY="$(api_body)"
assert_eq "A: record_response → 201" "$CODE" "201"
assert_eq "A: zero derived prospects (forceDnc short-circuits)" "$(echo "$BODY" | jq -r '.derivedProspects | length')" "0"
assert_eq "A: no prospect created for pointer email dm-a" "$(prospect_count_email "dm-a@$RUN_TAG.example")" "0"
assert_eq "A: referrer R_DNC itself ratcheted to DNC" "$(psql_local "SELECT do_not_contact FROM prospects WHERE id=$P_RDNC;")" "t"

step "Branch B: email dedup fills only missing fields"
PTR="$(jq -nc --arg t "$RUN_TAG" '{name:"Target Person", email:("contact@"+$t+"-target.example"), role:"VP Sales"}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_FILL" not_decision_maker "$PTR")")"; BODY="$(api_body)"
assert_eq "B: record_response → 201" "$CODE" "201"
assert_eq "B: matched_existing pointing at target" "$(echo "$BODY" | jq -r '.derivedProspects[0].action // ""')" "matched_existing"
assert_eq "B: target null contactName filled" "$(psql_local "SELECT contact_name FROM prospects WHERE id=$P_TARGET;")" "Target Person"
assert_eq "B: target null department filled" "$(psql_local "SELECT department FROM prospects WHERE id=$P_TARGET;")" "VP Sales"

step "Branch B5: populated fields are NOT overwritten"
PTR="$(jq -nc --arg t "$RUN_TAG" '{name:"Different Name", email:("contact@"+$t+"-target.example"), role:"Different Role"}')"
assert_eq "B5: record_response → 201" "$(api_status POST /api/responses "$(ptr_resp "$OL_FILL2" not_decision_maker "$PTR")")" "201"
assert_eq "B5: target fields unchanged (no overwrite)" \
  "$(psql_local "SELECT contact_name||'|'||department FROM prospects WHERE id=$P_TARGET;")" "Target Person|VP Sales"

step "Branch C: existing-DNC pointer match → no-op"
PTR="$(jq -nc --arg t "$RUN_TAG" '{name:"Should Not Apply", email:("contact@"+$t+"-dnctgt.example"), role:"CFO"}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_DNCTGT" not_decision_maker "$PTR")")"; BODY="$(api_body)"
assert_eq "C: record_response → 201" "$CODE" "201"
assert_eq "C: zero derived prospects (existing.doNotContact → null)" "$(echo "$BODY" | jq -r '.derivedProspects | length')" "0"
assert_eq "C: DNC target contactName/department still NULL" \
  "$(psql_local "SELECT (contact_name IS NULL AND department IS NULL) FROM prospects WHERE id=$P_DNCTGT;")" "t"

step "Branch D: self-reference skip (by email, by name)"
PTR="$(jq -nc --arg t "$RUN_TAG" '{email:("contact@"+$t+"-rself.example")}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_SELF" other "$PTR")")"; BODY="$(api_body)"
assert_eq "D1: self-ref by email → 201, zero derived" "$CODE/$(echo "$BODY" | jq -r '.derivedProspects | length')" "201/0"
PTR="$(jq -nc '{name:"Jane Self"}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_SELF2" other "$PTR")")"; BODY="$(api_body)"
assert_eq "D2: self-ref by name → 201, zero derived" "$CODE/$(echo "$BODY" | jq -r '.derivedProspects | length')" "201/0"
assert_eq "D3: still exactly one rself prospect (no recursive dup)" "$(prospect_count_email "contact@$RUN_TAG-rself.example")" "1"

step "Branch E/F: cross-tenant isolation → a NEW prospect is created in the caller's tenant"
PTR="$(jq -nc --arg t "$RUN_TAG" '{name:"Cross DM", email:("dm-xt@"+$t+".example"), role:"Head of Ops"}')"
CODE="$(api_status POST /api/responses "$(ptr_resp "$OL_XT" not_decision_maker "$PTR")")"; BODY="$(api_body)"
assert_eq "EF: record_response → 201" "$CODE" "201"
assert_eq "EF: action=created (foreign-tenant row invisible to dedup)" "$(echo "$BODY" | jq -r '.derivedProspects[0].action // ""')" "created"
assert_eq "EF: exactly one caller-tenant prospect with that email, DNC=false" \
  "$(psql_local "SELECT COUNT(*)::int FROM prospects WHERE tenant_id='$TENANT_ID' AND email='dm-xt@$RUN_TAG.example' AND do_not_contact=false;")" "1"
assert_eq "EF: derived inherits referrer R_XT's organization_id" \
  "$(psql_local "SELECT ((SELECT organization_id FROM prospects WHERE tenant_id='$TENANT_ID' AND email='dm-xt@$RUN_TAG.example') = (SELECT organization_id FROM prospects WHERE id=$P_RXT));")" "t"
assert_eq "EF: foreign-tenant row NOT touched (overview intact)" \
  "$(psql_local "SELECT overview FROM prospects WHERE id=$FOREIGN_PROSPECT_ID;")" "foreign overview"
assert_eq "EF: derived linked to the referrer's project" \
  "$(psql_local "SELECT COUNT(*)::int FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=(SELECT id FROM prospects WHERE tenant_id='$TENANT_ID' AND email='dm-xt@$RUN_TAG.example');")" "1"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
