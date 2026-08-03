#!/usr/bin/env bash
# Regression for the 'platform' channel (user-defined playbook means).
#
# Covers the DB-coupled invariants added with prospects.platform_url +
# channel 'platform':
#
#  (1) REGISTRATION. A platformUrl-only prospect satisfies the ≥1-contact-
#      channel rule; a batch row with no channel at all is still 400. Dedup is
#      by platformUrl (platform_url_duplicate), and a platform candidate
#      BYPASSES the org-domain project dedup — a second posting from the same
#      org/platform domain inserts instead of skipping already_in_project.
#
#  (2) REACHABILITY. platform is not in the default outboundChannels, so
#      platform-only prospects stay invisible to get_outbound_targets until
#      the project enables the channel; once enabled they surface with
#      platformUrl + discoveryStrategy and count in byChannel.platformOnly.
#
#  (3) OUTREACH + NO FOOTER. record-with-inquiry accepts channel 'platform'
#      and appends NO compliance footer in either mode (finalBody == body,
#      no inquiry token minted); pre_send resolves to sent via the normal
#      two-phase flow and flips the prospect to contacted.
#
#  (4) STATS. The reply flows into channelResponseRate under 'platform' and
#      into discoveryStrategyResponseRate under the registering slug.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres).
# Curl-only, cleans up.
#
# Usage:
#   ./e2e/regression-platform-channel.sh
#   SKIP_CLEANUP=1 ./e2e/regression-platform-channel.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-platform-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
# Every body reaching a pre-send path must be mutually dissimilar: the content
# check refuses a near-duplicate of any recent body in the tenant, including
# bodies left behind by an earlier run.
new_body() { printf 'e2e platform proposal body %s' "$(openssl rand -hex 32)"; }
CORE_BODY=""
STRATEGY_SLUG="crowdsource-postings"
PLATFORM_DOMAIN="$RUN_TAG.example"

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
require_openssl() { command -v openssl >/dev/null 2>&1 || { echo "need openssl on PATH (fixture bodies must be unique per call)" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

last_log_id()   { psql_local "SELECT id FROM outreach_logs WHERE prospect_id=$1 AND project_id='$PROJECT_ID' ORDER BY id DESC LIMIT 1;"; }
last_log_body() { psql_local "SELECT body FROM outreach_logs WHERE id=$1;"; }
token_count()   { psql_local "SELECT COUNT(*)::int FROM inquiry_tokens WHERE outreach_log_id=$1;"; }
pp_status()     { psql_local "SELECT status FROM project_prospects WHERE prospect_id=$1 AND project_id='$PROJECT_ID';"; }

# Platform lead: platformUrl only, org = the platform itself, no email/form/sns.
mkplatform() {
  local posting="$1"
  jq -nc --arg d "$PLATFORM_DOMAIN" --arg u "https://$PLATFORM_DOMAIN/jobs/$posting" \
     --arg n "Posting $posting" --arg s "$STRATEGY_SLUG" \
    '{organizationDomain:$d, organizationName:"E2E Platform", organizationWebsiteUrl:("https://"+$d),
      name:$n, overview:"platform posting seed", websiteUrl:$u, platformUrl:$u,
      matchReason:"seed", discoveryStrategy:$s}'
}

rwi_body() { jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" --arg b "$2" \
  '{projectId:$pid, prospectId:$prid, channel:"platform", body:$b}'; }

set_mode() {
  local m="$1"
  local resp; resp="$(api PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg m "$m" '{outboundMode:$m}')")"
  assert_eq "project outboundMode=$m" "$(echo "$resp" | jq -r '.outboundMode // ""')" "$m"
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
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND platform_url LIKE 'https://$PLATFORM_DOMAIN/%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain = '$PLATFORM_DOMAIN';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: tenant compliance + project"
api PUT /api/tenant-settings '{"legalName":"E2E Platform Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

step "(1) registration: platformUrl-only passes; no-channel row is 400"
SEED_RESP="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" --argjson a "$(mkplatform 1)" '{projectId:$pid, prospects:[$a]}')")"
assert_eq "platform-only prospect inserted" "$(echo "$SEED_RESP" | jq -r '.inserted // 0')" "1"
P_A="$(echo "$SEED_RESP" | jq -r '.insertedIds[0] // ""')"
[[ -n "$P_A" ]] || { echo "no inserted id: $SEED_RESP" >&2; exit 1; }

NOCHAN="$(jq -nc --arg d "$PLATFORM_DOMAIN" \
  '{organizationDomain:$d, organizationName:"E2E Platform", organizationWebsiteUrl:("https://"+$d),
    name:"no channel", overview:"seed", websiteUrl:("https://"+$d), matchReason:"seed"}')"
CODE="$(api_status POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" --argjson x "$NOCHAN" '{projectId:$pid, prospects:[$x]}')")"
assert_eq "row with no contact channel → 400" "$CODE" "400"

step "(1) dedup: same platformUrl skips; second posting same domain inserts"
SEED2="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" --argjson dup "$(mkplatform 1)" --argjson b "$(mkplatform 2)" '{projectId:$pid, prospects:[$dup,$b]}')")"
assert_eq "second batch inserted=1 (posting 2 only)" "$(echo "$SEED2" | jq -r '.inserted // 0')" "1"
assert_eq "duplicate posting skipped as platform_url_duplicate" \
  "$(echo "$SEED2" | jq -r '.skippedDetails[0].reason // ""')" "platform_url_duplicate"
P_B="$(echo "$SEED2" | jq -r '.insertedIds[0] // ""')"
[[ -n "$P_B" ]] || { echo "no inserted id for posting 2: $SEED2" >&2; exit 1; }
say "ids: A=$P_A B=$P_B"

step "(2) reachability: invisible until the platform channel is enabled"
REACH="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=50")"
assert_eq "default channels → total 0" "$(echo "$REACH" | jq -r '.total // -1')" "0"
assert_eq "default channels → byChannel.platformOnly 0" "$(echo "$REACH" | jq -r '.byChannel.platformOnly // -1')" "0"

api PUT "/api/projects/$PROJECT_ID/settings" '{"outboundChannels":["email","platform"]}' > /dev/null
REACH="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=50")"
assert_eq "platform enabled → total 2" "$(echo "$REACH" | jq -r '.total // -1')" "2"
assert_eq "platform enabled → byChannel.platformOnly 2" "$(echo "$REACH" | jq -r '.byChannel.platformOnly // -1')" "2"
assert_eq "target carries platformUrl" \
  "$(echo "$REACH" | jq -r --argjson id "$P_A" '.prospects[] | select(.prospectId == $id) | .platformUrl')" \
  "https://$PLATFORM_DOMAIN/jobs/1"
assert_eq "target carries discoveryStrategy" \
  "$(echo "$REACH" | jq -r --argjson id "$P_A" '.prospects[] | select(.prospectId == $id) | .discoveryStrategy')" \
  "$STRATEGY_SLUG"

step "(3) send mode: channel platform, finalBody == body (no footer), no inquiry token"
set_mode send
CORE_BODY="$(new_body)"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_A" "$CORE_BODY")")"; BODY="$(api_body)"
assert_eq "platform record-with-inquiry → 201" "$CODE" "201"
assert_eq "status=pre_send" "$(echo "$BODY" | jq -r '.status // ""')" "pre_send"
assert_eq "finalBody == body verbatim (no compliance footer)" "$(echo "$BODY" | jq -r '.finalBody')" "$CORE_BODY"
assert_eq "inquiryUrl is null" "$(echo "$BODY" | jq -r '.inquiryUrl')" "null"
LID_A="$(last_log_id "$P_A")"
assert_eq "no inquiry token minted" "$(token_count "$LID_A")" "0"
assert_eq "persisted body == input body" "$(last_log_body "$LID_A")" "$CORE_BODY"

api PATCH "/api/outreach/$LID_A/status" '{"status":"sent"}' > /dev/null
assert_eq "sent flips prospect to contacted" "$(pp_status "$P_A")" "contacted"

step "(3) draft mode: pending_review body carries no footer either"
set_mode draft
CORE_BODY="$(new_body)"
CODE="$(api_status POST /api/outreach/record-with-inquiry "$(rwi_body "$P_B" "$CORE_BODY")")"; BODY="$(api_body)"
assert_eq "platform draft → 201" "$CODE" "201"
assert_eq "status=pending_review" "$(echo "$BODY" | jq -r '.status // ""')" "pending_review"
LID_B="$(last_log_id "$P_B")"
assert_eq "draft persisted body == input body (no footer baked)" "$(last_log_body "$LID_B")" "$CORE_BODY"

step "(4) stats: reply flows into channel + discovery-strategy axes"
RESP_BODY="$(jq -nc --argjson lid "$LID_A" \
  '{outreachLogId:$lid, channel:"platform", content:"interested, please share details", sentiment:"positive", responseType:"reply"}')"
CODE="$(api_status POST /api/responses "$RESP_BODY")"
assert_eq "record platform response → 201" "$CODE" "201"
assert_eq "reply flips prospect to responded" "$(pp_status "$P_A")" "responded"

STATS="$(api GET "/api/projects/$PROJECT_ID/stats")"
assert_eq "channelResponseRate has a platform row (sent=1, responses=1)" \
  "$(echo "$STATS" | jq -r '[.metrics.channelResponseRate[]? | select(.channel=="platform")][0] | "\(.total // "?")/\(.responses // "?")"')" \
  "1/1"
assert_eq "discoveryStrategyResponseRate has the strategy bucket" \
  "$(echo "$STATS" | jq -r --arg s "$STRATEGY_SLUG" '[.metrics.discoveryStrategyResponseRate[]? | select(.strategy==$s)] | length')" \
  "1"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
