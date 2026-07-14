#!/usr/bin/env bash
# Regression for closed-loop Phase B (deterministic targeting score):
#
#   1. R5 default: before any tick, every ordering_score is 1.0 and the
#      reachable ordering follows the priority multiplier alone (P1 first).
#   2. run-lever-tick computes shrinkage lifts per attribute axis, persists
#      them to lever_state.targeting_lifts, and materializes the composite
#      (clamped [0.5, 2.0]) into project_prospects.ordering_score.
#   3. Measured beats discretion: after the tick, a neutral-priority prospect
#      in the measured-hot segment outranks a P1 prospect in the measured-cold
#      segment (composite lift range 4x > priority multiplier range 3x).
#   4. Rows registered after the tick keep the neutral default 1.0.
#   5. Tick idempotency: a same-day re-run reports ran=false and echoes the
#      recorded targetingLifts.
#   6. Exploration share: explorationShare=1.0 turns the whole batch into
#      random draws — returned rows are still unique and complete.
#
# Seed: 6 mature sends (backdated 15d) — 3 "hot" (B2B SaaS / 11-50 /
# hot-src, each drawing a meeting_request) and 3 "cold" (FinTech / 201+ /
# cold-src, silent). With priorStrength=5: r0=0.5, hot axis lift 1.375,
# cold 0.625 → composite hot 1.375^3 → clamps to 2.0, cold 0.625^3 → 0.5
# (country US spans both segments → lift exactly 1.0). Reachable pool =
# H1, H2 (priority 3, hot attrs) + C1 (priority 1, cold attrs).
#
# Curl-only, no Claude session. Cleans up.
#
# Usage:
#   ./e2e/regression-targeting-score.sh
#   SKIP_CLEANUP=1 ./e2e/regression-targeting-score.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-tscore-$(date +%s)"
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

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

# mkseed tag industry band slug priority
mkseed() {
  local tag="$1" industry="$2" band="$3" slug="$4" priority="$5"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    --arg i "$industry" --arg b "$band" --arg s "$slug" --argjson pr "$priority" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual", industry:$i, employeeBand:$b, discoveryStrategy:$s,
      priority:$pr, name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

send_email() { # prospectId → outreach_log id
  api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"seed", status:"sent"}')" \
    | jq -r '.id // ""'
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

ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"

# Dedicated dummy identity so the mailbox ramp cap never depends on the local
# fallback identity's real send history (same pattern as regression-bounce-stats).
ENC_KEY="$(grep -E '^GMAIL_TOKEN_ENCRYPTION_KEY=' "$REPO_ROOT/backend/.dev.vars" | head -1 | cut -d= -f2- | tr -d '"')"
[[ -n "$ENC_KEY" ]] || { echo "could not read GMAIL_TOKEN_ENCRYPTION_KEY from backend/.dev.vars" >&2; exit 1; }
SECRET_PAYLOAD="$(jq -nc --arg e "$RUN_TAG@example.com" \
  '{smtpHost:"smtp.example.com", smtpPort:465, imapHost:"imap.example.com", imapPort:993, username:$e, appPassword:"e2e-dummy"}')"
IDENTITY_ID="$(psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret)
  VALUES ('$TENANT_ID', replace(gen_random_uuid()::text,'-',''), '$USER_ID', 'smtp_imap', '$RUN_TAG@example.com', NULL, pgp_sym_encrypt('$SECRET_PAYLOAD'::text, '$ENC_KEY'))
  RETURNING identity_id;" | head -1)"
[[ -n "$IDENTITY_ID" ]] || { echo "failed to insert dummy sending identity" >&2; exit 1; }
say "dummy identity_id=$IDENTITY_ID"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>}, identity $IDENTITY_ID, and run rows as-is." >&2
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
    say "deleted project $PROJECT_ID (outreach_logs / lever rows cascade)"
  fi
  psql_local "DELETE FROM sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id='$IDENTITY_ID';" > /dev/null || true
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE '%@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped run-tagged rows"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance + project + leverConfig (priorStrength=5, explorationShare=0)"
api PUT /api/tenant-settings '{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null

PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SETTINGS_RESP="$(api PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg i "$IDENTITY_ID" \
  '{sendingIdentityId:$i, leverConfig:{priorStrength:5, explorationShare:0}}')")"
assert_eq "identity assigned" "$(echo "$SETTINGS_RESP" | jq -r '.sendingIdentityId // ""')" "$IDENTITY_ID"

step "seed: 6 sent prospects (3 hot replied, 3 cold silent) + reachable H1,H2 (P3) and C1 (P1)"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson s1 "$(mkseed hot-1 'B2B SaaS' '11-50' hot-src 3)" \
  --argjson s2 "$(mkseed hot-2 'B2B SaaS' '11-50' hot-src 3)" \
  --argjson s3 "$(mkseed hot-3 'B2B SaaS' '11-50' hot-src 3)" \
  --argjson s4 "$(mkseed cold-1 'FinTech' '201+' cold-src 3)" \
  --argjson s5 "$(mkseed cold-2 'FinTech' '201+' cold-src 3)" \
  --argjson s6 "$(mkseed cold-3 'FinTech' '201+' cold-src 3)" \
  --argjson h1 "$(mkseed H1 'B2B SaaS' '11-50' hot-src 3)" \
  --argjson h2 "$(mkseed H2 'B2B SaaS' '11-50' hot-src 3)" \
  --argjson c1 "$(mkseed C1 'FinTech' '201+' cold-src 1)" \
  '{projectId:$pid, prospects:[$s1,$s2,$s3,$s4,$s5,$s6,$h1,$h2,$c1]}')"
assert_eq "seed inserted=9" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "9"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_S1="$(pid_of hot-1)"; P_S2="$(pid_of hot-2)"; P_S3="$(pid_of hot-3)"
P_S4="$(pid_of cold-1)"; P_S5="$(pid_of cold-2)"; P_S6="$(pid_of cold-3)"
P_H1="$(pid_of H1)"; P_H2="$(pid_of H2)"; P_C1="$(pid_of C1)"
[[ -n "$P_S1" && -n "$P_S2" && -n "$P_S3" && -n "$P_S4" && -n "$P_S5" && -n "$P_S6" && -n "$P_H1" && -n "$P_H2" && -n "$P_C1" ]] \
  || { echo "could not resolve prospect ids" >&2; exit 1; }

step "Test 1: pre-tick R5 default — neutral scores, priority multiplier decides"
assert_eq "all 9 rows at neutral score" \
  "$(psql_local "SELECT count(*)::int FROM project_prospects WHERE project_id='$PROJECT_ID' AND ordering_score = 1.0;")" "9"
PRE="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=1")"
assert_eq "P1 cold prospect leads before any measurement" \
  "$(echo "$PRE" | jq -r '.prospects[0].email')" "contact@$RUN_TAG-C1.example"

step "seed mature sends + replies"
for prid in "$P_S1" "$P_S2" "$P_S3" "$P_S4" "$P_S5" "$P_S6"; do
  LID="$(send_email "$prid")"
  [[ -n "$LID" ]] || { echo "send seeding failed for prospect $prid" >&2; exit 1; }
done
psql_local "UPDATE outreach_logs SET sent_at = now() - interval '15 days' WHERE project_id = '$PROJECT_ID';" > /dev/null
for prid in "$P_S1" "$P_S2" "$P_S3"; do
  LID="$(psql_local "SELECT id FROM outreach_logs WHERE project_id='$PROJECT_ID' AND prospect_id=$prid LIMIT 1;")"
  api POST /api/responses "$(jq -nc --argjson lid "$LID" \
    '{outreachLogId:$lid, channel:"email", content:"e2e meeting", sentiment:"positive", responseType:"meeting_request"}')" >/dev/null
done
say "6 mature sends, 3 hot meeting_requests"

step "Test 2: tick computes lifts and materializes ordering_score"
TICK="$(api POST "/api/projects/$PROJECT_ID/run-lever-tick")"
assert_eq "tick ran" "$(echo "$TICK" | jq -r '.ran')" "true"
assert_eq "tick returns targetingLifts" "$(echo "$TICK" | jq -r '.targetingLifts != null')" "true"
IND_LIFTS="$(echo "$TICK" | jq -c '.targetingLifts.industry')"
assert_eq "software_tech lift = 1.375 (shrinkage, k=5, r0=0.5)" \
  "$(echo "$IND_LIFTS" | jq -r '.[] | select(.value=="software_tech") | .lift')" "1.375"
assert_eq "vertical_tech lift = 0.625" \
  "$(echo "$IND_LIFTS" | jq -r '.[] | select(.value=="vertical_tech") | .lift')" "0.625"
assert_eq "country US lift = 1.0 (spans both segments = the project baseline)" \
  "$(echo "$TICK" | jq -r '.targetingLifts.country[] | select(.value=="US") | .lift')" "1"
STATE_LIFTS="$(psql_local "SELECT targeting_lifts FROM lever_state WHERE project_id='$PROJECT_ID';")"
assert_eq "lever_state.targeting_lifts persisted" \
  "$(echo "$STATE_LIFTS" | jq -r '.industry | length > 0' 2>/dev/null)" "true"
assert_eq "H1 composite clamped to 2.0 (1.375^3 > max)" \
  "$(psql_local "SELECT ordering_score FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=$P_H1;")" "2"
assert_eq "C1 composite clamped to 0.5 (0.625^3 < min)" \
  "$(psql_local "SELECT ordering_score FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=$P_C1;")" "0.5"

step "Test 3: measured beats discretion — hot P3 outranks cold P1"
POST_TICK="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=3")"
assert_eq "reachable total=3" "$(echo "$POST_TICK" | jq -r '.total')" "3"
assert_eq "1st = H1 (score 2.0 x P3 1.0)" "$(echo "$POST_TICK" | jq -r '.prospects[0].email')" "contact@$RUN_TAG-H1.example"
assert_eq "2nd = H2 (createdAt tiebreak)"  "$(echo "$POST_TICK" | jq -r '.prospects[1].email')" "contact@$RUN_TAG-H2.example"
assert_eq "3rd = C1 despite P1 (0.5 x 1.5 = 0.75)" "$(echo "$POST_TICK" | jq -r '.prospects[2].email')" "contact@$RUN_TAG-C1.example"

step "Test 4: rows registered after the tick stay at the neutral default"
LATE_BODY="$(jq -nc --arg pid "$PROJECT_ID" --argjson l "$(mkseed late 'B2B SaaS' '11-50' hot-src 3)" '{projectId:$pid, prospects:[$l]}')"
assert_eq "late row inserted" "$(api POST /api/prospects/batch "$LATE_BODY" | jq -r '.inserted')" "1"
P_LATE="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200" | jq -r --arg e "contact@$RUN_TAG-late.example" '.prospects[]? | select(.email == $e) | .prospectId')"
assert_eq "late row score = 1.0 until the next tick" \
  "$(psql_local "SELECT ordering_score FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=$P_LATE;")" "1"

step "Test 5: same-day tick re-run is idempotent and echoes the lifts"
TICK2="$(api POST "/api/projects/$PROJECT_ID/run-lever-tick")"
assert_eq "second tick ran=false" "$(echo "$TICK2" | jq -r '.ran')" "false"
assert_eq "second tick echoes targetingLifts" "$(echo "$TICK2" | jq -r '.targetingLifts != null')" "true"

step "Test 6: explorationShare=1.0 — full random batch, unique and complete"
api PUT "/api/projects/$PROJECT_ID/settings" '{"leverConfig":{"priorStrength":5, "explorationShare":1.0}}' > /dev/null
EXPLORE="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=4")"
assert_eq "4 rows returned (pool of 4)" "$(echo "$EXPLORE" | jq -r '.prospects | length')" "4"
assert_eq "no duplicate prospects in the merged batch" \
  "$(echo "$EXPLORE" | jq -r '[.prospects[].prospectId] | length == (unique | length)')" "true"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
