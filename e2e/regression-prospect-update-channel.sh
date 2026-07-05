#!/usr/bin/env bash
# Regression for the PATCH /prospects/:id post-merge contact-channel invariant.
#
# updateProspect (services/prospects.ts:833-899) merges the patch over the
# STORED row and refuses the write if no contact channel (email, contactFormUrl,
# or a truthy snsAccounts value) would remain — UNPROCESSABLE (422). The
# invariant depends on the stored row, so the type system can't express it: a
# {email:null} patch is fatal for an email-only prospect but harmless when a
# contactFormUrl is also stored. A regression here leaves a prospect permanently
# unreachable. NOT_FOUND (404) precedes the channel check, so a bogus id is 404.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). PATCH
# /prospects has no compliance/quota/plan gate, so this is fully self-host
# runnable and touches no shared tenant state. Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-prospect-update-channel.sh
#   SKIP_CLEANUP=1 ./e2e/regression-prospect-update-channel.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-pchan-$(date +%s)"
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
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  # Delete prospects by org domain (the sns-only prospect has NULL email so the
  # email-LIKE filter used elsewhere would miss it and orphan the row).
  psql_local "DELETE FROM prospects WHERE tenant_id='$TENANT_ID' AND organization_id IN (SELECT id FROM organizations WHERE tenant_id='$TENANT_ID' AND domain LIKE '$RUN_TAG-%');" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id='$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed 3 prospects (email-only / sns-only / multi-channel)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

EMO_DOM="$RUN_TAG-emo.example"; SNS_DOM="$RUN_TAG-sns.example"; MULTI_DOM="$RUN_TAG-multi.example"
EMAIL_ONLY="$(jq -nc --arg d "$EMO_DOM" --arg e "contact@$EMO_DOM" \
  '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
    country:"US", countrySource:"manual", name:"P-emo", overview:"seed",
    websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}')"
SNS_ONLY="$(jq -nc --arg d "$SNS_DOM" \
  '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
    country:"US", countrySource:"manual", name:"P-sns", overview:"seed",
    websiteUrl:("https://"+$d+"/about"), snsAccounts:{x:"acme_x"}, matchReason:"seed"}')"
MULTI="$(jq -nc --arg d "$MULTI_DOM" --arg e "contact@$MULTI_DOM" --arg f "https://$MULTI_DOM/contact" \
  '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
    country:"US", countrySource:"manual", name:"P-multi", overview:"seed",
    websiteUrl:("https://"+$d+"/about"), email:$e, contactFormUrl:$f, matchReason:"seed"}')"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson emo "$EMAIL_ONLY" --argjson sns "$SNS_ONLY" --argjson multi "$MULTI" \
  '{projectId:$pid, prospects:[$emo,$sns,$multi]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
P_EMO="$(echo "$LIST_RESP" | jq -r --arg e "contact@$EMO_DOM" '.prospects[]? | select(.email == $e) | .prospectId' | head -1)"
P_MULTI="$(echo "$LIST_RESP" | jq -r --arg e "contact@$MULTI_DOM" '.prospects[]? | select(.email == $e) | .prospectId' | head -1)"
P_SNS="$(echo "$LIST_RESP" | jq -r '.prospects[]? | select(.name == "P-sns") | .prospectId' | head -1)"
[[ -n "$P_EMO" && -n "$P_MULTI" && -n "$P_SNS" ]] || { echo "could not resolve prospect ids" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: emo=$P_EMO sns=$P_SNS multi=$P_MULTI"

step "T1: email-only, strip the only channel → 422"
CODE="$(api_status PATCH "/api/prospects/$P_EMO" '{"email":null}')"; BODY="$(api_body)"
assert_eq "strip last channel → 422" "$CODE" "422"
assert_eq "error = channel-required message" "$(echo "$BODY" | jq -r '.error // ""')" \
  "At least one contact channel (email, contactFormUrl, or snsAccounts) is required"
assert_eq "DB email unchanged (UPDATE never ran)" \
  "$(psql_local "SELECT email FROM prospects WHERE id=$P_EMO;")" "contact@$EMO_DOM"

step "T2: sns-only, clearing/emptying the only channel → 422"
CODE="$(api_status PATCH "/api/prospects/$P_SNS" '{"snsAccounts":null}')"
assert_eq "clear snsAccounts (null) → 422" "$CODE" "422"
CODE="$(api_status PATCH "/api/prospects/$P_SNS" '{"snsAccounts":{}}')"
assert_eq "empty snsAccounts ({}) is not a channel → 422" "$CODE" "422"
assert_eq "DB sns.x still stored" "$(psql_local "SELECT sns_accounts->>'x' FROM prospects WHERE id=$P_SNS;")" "acme_x"

step "T3: email-only, swap email→form in one patch → 200 (channel remains)"
CODE="$(api_status PATCH "/api/prospects/$P_EMO" "$(jq -nc --arg f "https://$EMO_DOM/contact" '{email:null, contactFormUrl:$f}')")"
assert_eq "swap last channel → 200" "$CODE" "200"
assert_eq "DB: email cleared, form set" \
  "$(psql_local "SELECT (email IS NULL AND contact_form_url='https://$EMO_DOM/contact') FROM prospects WHERE id=$P_EMO;")" "t"

step "T4: multi-channel, drop one of two → 200 (form survives)"
CODE="$(api_status PATCH "/api/prospects/$P_MULTI" '{"email":null}')"
assert_eq "drop one of two channels → 200" "$CODE" "200"
assert_eq "DB: email cleared, form survives" \
  "$(psql_local "SELECT (email IS NULL AND contact_form_url IS NOT NULL) FROM prospects WHERE id=$P_MULTI;")" "t"

step "T5: non-channel patch on a valid prospect → 200 (invariant not over-firing)"
CODE="$(api_status PATCH "/api/prospects/$P_SNS" '{"notes":"e2e note"}')"
assert_eq "notes-only patch → 200" "$CODE" "200"

step "T6: NOT_FOUND precedes the channel check — bogus id → 404 (not 422)"
CODE="$(api_status PATCH "/api/prospects/999999999" '{"email":null}')"
assert_eq "patch non-existent prospect → 404" "$CODE" "404"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
