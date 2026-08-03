#!/usr/bin/env bash
# Regression for the pre-send content check (assertSendableContent in
# services/outreach.ts + domain/outbound-content.ts).
#
# The pure rules are unit-tested (domain/outbound-content.test.ts). What only a
# live stack can pin is the half that needs the database and the guard's place in
# the send path:
#
#  (1) NEAR-DUPLICATE AGAINST REAL ROWS. The check compares the incoming body to
#      the tenant's recent outreach_logs bodies. A clean body is accepted; the
#      same body with only the recipient's name swapped is refused on the next
#      call, because the first call's row is now a prior. No unit test can cover
#      this — the prior set is a query.
#  (2) THE GUARD IS WIRED, AND WIRED IN DRAFT MODE TOO. Every leg below runs with
#      outboundMode=draft, so a refusal here proves the check fires where the
#      body is composed, not only at send time. Nothing is ever sent.
#  (3) THE 422 DETAIL IS ACTIONABLE. Each leg asserts the detail names the actual
#      problem — that string is what the plugin reads to rewrite and retry, so a
#      generic message would be a silent regression.
#
# Fixture bodies carry a random suffix so a leftover row from an interrupted run
# cannot make the "clean body accepted" leg fail; the near-duplicate pair shares
# that suffix, so it stays a duplicate of its own partner only.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Snapshots
# + restores tenant compliance (shared state). Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-content-check.sh
#   SKIP_CLEANUP=1 ./e2e/regression-content-check.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-content-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"

# The own-host leg plants a URL the check must recognise as ours. It compares
# hostnames (domain/outbound-content: `new URL(x).hostname`), so the port never
# enters the match and scripts/dev.sh always builds APP_URL on `localhost` —
# any localhost port works here.
OWN_HOST_URL="http://localhost:5273/pricing"

PROBE_ADDRESS="456 Probe Avenue, Probe City, CA 94000"

PASS=0
FAIL=0

step() { printf '\n=== %s ===\n' "$1" >&2; }
say()  { printf '  %s\n' "$1" >&2; }

api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}

API_OUT=""
send_and_record() {
  local payload="$1"
  curl -sS -o "$API_OUT" -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "$payload" "$API_URL/api/outreach/send-and-record"
}

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
require_openssl() { command -v openssl >/dev/null 2>&1 || { echo "need openssl on PATH (fixture bodies must be unique per call)" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

log_count() { psql_local "SELECT count(*)::int FROM outreach_logs WHERE project_id='$PROJECT_ID';"; }

# label / prospect / body / expected status / substring the detail must carry
probe() {
  local label="$1" prid="$2" body="$3" want_code="$4" want_detail="$5"
  local payload code detail
  payload="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" --arg b "$body" \
    '{projectId:$pid, prospectId:$prid, subject:"e2e content check", body:$b}')"
  code="$(send_and_record "$payload")"
  detail="$(jq -r '.detail // .error // ""' < "$API_OUT")"
  if [[ "$code" == "$want_code" && "$detail" == *"$want_detail"* ]]; then
    printf '  ok  %-30s → %s\n' "$label" "$code"; PASS=$((PASS + 1))
  else
    printf '  FAIL %-30s → %s (want %s)\n       detail want: %s\n       detail got:  %s\n' \
      "$label" "$code" "$want_code" "$want_detail" "$detail" >&2; FAIL=$((FAIL + 1))
  fi
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok  %s\n' "$label"; PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       want: %s\n       got:  %s\n' "$label" "$expected" "$actual" >&2; FAIL=$((FAIL + 1))
  fi
}

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

require_jq
require_openssl
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
    # Explicit: the accepted-body row is a near-duplicate prior for the next run.
    psql_local "DELETE FROM outreach_logs WHERE tenant_id='$TENANT_ID' AND project_id='$PROJECT_ID';" > /dev/null || true
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID and its outreach rows"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance + project (DRAFT mode) + 3 prospects"
api PUT /api/tenant-settings "$(jq -nc --arg addr "$PROBE_ADDRESS" \
  '{legalName:"E2E Content Corp", physicalAddress:$addr, defaultSenderCountry:"US"}')" > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
# Draft mode: every leg below exercises the check without any Gmail call.
api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"draft"}' > /dev/null
say "project_id=$PROJECT_ID (draft mode)"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed a)" --argjson b "$(mkseed b)" --argjson c "$(mkseed c)" \
  '{projectId:$pid, prospects:[$a,$b,$c]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=3" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_A="$(pid_of a)"; P_B="$(pid_of b)"; P_C="$(pid_of c)"
[[ -n "$P_A" && -n "$P_B" && -n "$P_C" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
say "ids: a=$P_A b=$P_B c=$P_C"

NONCE="$(openssl rand -hex 128)"
CLEAN_BODY="Hi Sam, your changelog entry on the ingest API caught my eye — the retry semantics are unusual for that volume. We build the reconciliation layer that catches the duplicates it produces. Worth a quick reply to compare notes? $NONCE"

step "violations are refused (422), and the detail says which one"
BEFORE="$(log_count)"
probe "unfilled placeholder" "$P_A" \
  "Hi {first name}, your changelog entry caught my eye and seemed worth a note. Worth a quick reply?" \
  422 "unfilled placeholder"
probe "our own app host in body" "$P_A" \
  "Hi Sam, saw your changelog. More on how we handle it at $OWN_HOST_URL — worth a quick reply?" \
  422 "strongest spam signal"
probe "self-written footer separator" "$P_A" \
  "$(printf 'Hi Sam, your changelog entry seemed worth a note.\n---\nE2E Content Corp')" \
  422 "separator line"
probe "legal address restated in body" "$P_A" \
  "Hi Sam, saw your changelog. We sit at $PROBE_ADDRESS. Worth a quick reply?" \
  422 "legal postal address"
probe "body past the length ceiling" "$P_A" \
  "$(printf 'word %.0s' {1..230})" \
  422 "hard limit 220"
assert_eq "no refused leg wrote a row" "$(log_count)" "$BEFORE"

step "a clean body is accepted; its near-duplicate is not"
probe "clean body" "$P_B" "$CLEAN_BODY" 201 ""
assert_eq "accepted body wrote one row" "$(log_count)" "$((BEFORE + 1))"
probe "same body, name swapped" "$P_C" "${CLEAN_BODY/Sam/Alex}" 422 "identical to outreach"
assert_eq "refused duplicate wrote no row" "$(log_count)" "$((BEFORE + 1))"

step "summary"
printf '  PASS=%s  FAIL=%s\n' "$PASS" "$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
