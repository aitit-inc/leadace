#!/usr/bin/env bash
# Net-new regression for PR #70 (single-source plugin config + skip_prospect).
# Covers the two server-side behaviors the plugin refactor leans on, which the
# existing outbound/dedup harnesses do NOT exercise:
#
#   1. listReachable hard country filter (B2 candidate-stage jurisdiction guard)
#      — GET /projects/:id/prospects/reachable mirrors isAllowedSendCountry at
#      the candidate stage: COALESCE(prospect.country, org.country) is admitted
#      when it's US/CA/JP OR NULL (warn-and-allow), and excluded otherwise. This
#      is why the skill no longer pre-filters by country or fabricates a skip
#      row for an unsupported jurisdiction.
#
#   2. skip_prospect (POST /outreach/skip) — writes a 'skipped' audit row with a
#      structured skip_reason, errorMessage NULL, consumes NO quota, does NOT
#      flip the prospect to 'contacted', and defers re-eligibility so the
#      prospect drops out of the candidate pool for the recycle window. Replaces
#      the old pattern of fabricating a 'failed' row. All three skip_reason
#      variants (bad_timing, no_fresh_material, other) are asserted.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Mints its
# own JWT via mint-jwt.sh, creates a throwaway project, and cleans up on exit.
# Does NOT touch tenant settings (neither path depends on them) nor
# sending_identities. Curl-only, no Claude session, no Anthropic budget.
#
# Usage:
#   ./e2e/regression-skip-reachable.sh
#   SKIP_CLEANUP=1 ./e2e/regression-skip-reachable.sh   # leave artifacts to inspect
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-skip-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"

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

# Emits the HTTP status code on stdout, the response body on stderr — lets the
# caller assert the exact code without parsing the body. Same shape as
# regression-outbound.sh's api_status.
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

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

# Is prospect-id $2 present in the listReachable JSON $1? prints y/n.
reachable_has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
}

# Build one /prospects/batch element. $2 is the ISO country; empty => omit
# country/countrySource entirely so prospect.country lands NULL.
mkseed() {
  local tag="$1" country="$2"
  local dom="$RUN_TAG-$tag.example"
  if [[ -n "$country" ]]; then
    jq -nc --arg d "$dom" --arg e "contact@$dom" --arg c "$country" --arg n "P-$tag" \
      '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
        country:$c, countrySource:"manual",
        name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
  else
    jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
      '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
        name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
  fi
}

# ---------------------------------------------------------------------------
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
    echo "" >&2
    echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2
  echo "=== teardown ===" >&2
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

# ---------------------------------------------------------------------------
step "create test project"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

step "seed prospects (US/CA/JP supported, GB blocked, NULL warn-and-allow)"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson us "$(mkseed us US)" \
  --argjson ca "$(mkseed ca CA)" \
  --argjson jp "$(mkseed jp JP)" \
  --argjson gb "$(mkseed gb GB)" \
  --argjson nul "$(mkseed null '')" \
  '{projectId:$pid, prospects:[$us,$ca,$jp,$gb,$nul]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
assert_eq "seed inserted=5" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "5"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
US_ID="$(pid_of us)"; CA_ID="$(pid_of ca)"; JP_ID="$(pid_of jp)"; GB_ID="$(pid_of gb)"; NULL_ID="$(pid_of null)"
[[ -n "$US_ID" && -n "$CA_ID" && -n "$JP_ID" && -n "$GB_ID" && -n "$NULL_ID" ]] || {
  echo "could not resolve prospect ids from /projects/$PROJECT_ID/prospects" >&2; echo "$LIST_RESP" >&2; exit 1; }
say "ids: us=$US_ID ca=$CA_ID jp=$JP_ID gb=$GB_ID null=$NULL_ID"

# The NULL prospect must genuinely have no country at either level so the
# isNull branch of hardCountryFilter is what admits it — not an inferred ccTLD
# ('.example' is intentionally not a ccTLD, so inferCountryFromDomain returns
# null).
NULL_COUNTRIES="$(psql_local "SELECT COALESCE(p.country,'-')||'/'||COALESCE(o.country,'-') FROM prospects p JOIN organizations o ON o.id=p.organization_id WHERE p.id=$NULL_ID;")"
assert_eq "NULL prospect has no country (prospect/org)" "$NULL_COUNTRIES" "-/-"

# ---------------------------------------------------------------------------
step "Test 1: listReachable admits US/CA/JP/NULL, excludes GB (hard country filter)"
R1="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "reachable.US present"                 "$(reachable_has "$R1" "$US_ID")"   "y"
assert_eq "reachable.CA present"                 "$(reachable_has "$R1" "$CA_ID")"   "y"
assert_eq "reachable.JP present"                 "$(reachable_has "$R1" "$JP_ID")"   "y"
assert_eq "reachable.NULL present (warn-allow)"  "$(reachable_has "$R1" "$NULL_ID")" "y"
assert_eq "reachable.GB excluded (hard filter)"  "$(reachable_has "$R1" "$GB_ID")"   "n"
assert_eq "reachable.total=4"                    "$(echo "$R1" | jq -r '.total')"    "4"

# ---------------------------------------------------------------------------
step "Test 2: skip_prospect US (bad_timing) → 'skipped' audit row, not contacted"
SKIP_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$US_ID" \
  '{projectId:$pid, prospectId:$prid, channel:"email", reason:"bad_timing", note:"e2e net-new skip"}')"
SKIP_CODE="$(api_status POST /api/outreach/skip "$SKIP_BODY" 2>/tmp/regression-skip-out.$$ || true)"
SKIP_RESP="$(cat /tmp/regression-skip-out.$$)"; rm -f /tmp/regression-skip-out.$$
assert_eq "skip.http_status" "$SKIP_CODE" "201"
SKIP_ID="$(echo "$SKIP_RESP" | jq -r '.id // ""')"
[[ -n "$SKIP_ID" ]] || { echo "skip response missing id: $SKIP_RESP" >&2; FAIL=$((FAIL + 1)); }
# status / skip_reason / errorMessage(NULL) / channel — one round-trip.
SKIP_ROW="$(psql_local "SELECT status||'/'||COALESCE(skip_reason::text,'-')||'/'||COALESCE(error_message,'-')||'/'||channel FROM outreach_logs WHERE id=$SKIP_ID;")"
assert_eq "skip row = skipped/bad_timing/-(no error)/email" "$SKIP_ROW" "skipped/bad_timing/-/email"
assert_eq "prospect NOT flipped to contacted" \
  "$(psql_local "SELECT status FROM project_prospects WHERE prospect_id=$US_ID AND project_id='$PROJECT_ID';")" "new"

# ---------------------------------------------------------------------------
step "Test 3: skipped prospect drops out of listReachable, others remain"
R2="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "reachable.US now excluded (deferred)" "$(reachable_has "$R2" "$US_ID")"   "n"
assert_eq "reachable.CA still present"           "$(reachable_has "$R2" "$CA_ID")"   "y"
assert_eq "reachable.NULL still present"         "$(reachable_has "$R2" "$NULL_ID")" "y"
assert_eq "reachable.total=3"                    "$(echo "$R2" | jq -r '.total')"    "3"

# ---------------------------------------------------------------------------
step "Test 4: remaining skip_reason variants (no_fresh_material / other) recorded"
for pair in "$CA_ID:no_fresh_material" "$JP_ID:other"; do
  prid="${pair%%:*}"; reason="${pair##*:}"
  B="$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$prid" --arg r "$reason" \
    '{projectId:$pid, prospectId:$prid, channel:"email", reason:$r, note:"variant"}')"
  C="$(api_status POST /api/outreach/skip "$B" 2>/dev/null || true)"
  assert_eq "skip[$reason].http_status" "$C" "201"
  GOT="$(psql_local "SELECT skip_reason FROM outreach_logs WHERE prospect_id=$prid AND project_id='$PROJECT_ID' AND status='skipped' ORDER BY id DESC LIMIT 1;")"
  assert_eq "skip[$reason].skip_reason recorded" "$GOT" "$reason"
done

# ---------------------------------------------------------------------------
step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
