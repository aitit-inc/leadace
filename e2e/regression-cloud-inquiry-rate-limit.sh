#!/usr/bin/env bash
# Cloud-edition regression: per-source chat abuse ceilings (chat_rate_windows,
# services/chat-rate-limit.ts) on the two LLM-backed chat endpoints.
#
# Covered:
#   - inquiry chat (public, short_id auth): per-link daily ceiling
#     (INQUIRY_CHAT_TURNS_PER_LINK_PER_DAY=15). Reserve-first: the slot is
#     taken BEFORE the OpenAI call, so the counter increments even when the
#     LLM call itself fails — step 1 asserts the increment while tolerating
#     either OpenAI outcome (200 live reply / 502 bad key).
#   - the 429 at the cap fires pre-OpenAI (no LLM cost), and the conditional
#     upsert (setWhere) keeps `used` from ever exceeding the limit.
#   - preview chat (bearer auth): per-tenant daily ceiling
#     (PREVIEW_CHAT_TURNS_PER_TENANT_PER_DAY=100). This path runs under the
#     app_rls role, so it also exercises the RLS policy + GRANT on
#     chat_rate_windows (a missing grant = "permission denied" here).
#
# The ceilings are NOT edition-gated (they bind on self-host too); the cloud
# harness is used for its tenant-provisioning helpers, and because the free
# plan's chat quota (25 lifetime, checked before the rate gate) stays
# unexhausted here, the 429 proves the rate gate specifically.
#
# Targets the cloud worker on :8789 (override API_URL); start it with
# ./e2e/cloud-edition-up.sh.
#
# Usage:
#   ./e2e/regression-cloud-inquiry-rate-limit.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-inquiry-rate-limit.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-chat-rate-$TS@example.com"
# short_id must match inquiryShortIdParamSchema: /^[A-Za-z0-9_-]{22}$/ (a real
# 22-char nanoid). 16 random bytes → exactly 22 base64url chars in that alphabet.
SHORT="$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("base64url"))')"
source "$REPO_ROOT/e2e/lib-cloud.sh"

trap cloud_teardown EXIT

require_jq
API_OUT="$(mktemp)"
cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"
cloud_seed_plan "$T" free

# Public route (shortId is the auth) — no bearer.
post_msg() {
  curl -sS -o "$API_OUT" -w '%{http_code}' -X POST "$API_URL/api/inquiry/$1/message" \
    -H 'Content-Type: application/json' -d "$(jq -nc --arg m "$2" '{message:$m}')"
}

# Matches startOfTodayUtc() in services/plan-limits.ts (UTC midnight).
WINDOW_SQL="date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'"

rate_used() { # scope key
  psql_local "SELECT used FROM chat_rate_windows WHERE tenant_id='$T' AND scope='$1' AND key='$2' AND window_start = $WINDOW_SQL;"
}

step "seed the inquiry FK chain (project → prospect → outreach_log → token → session)"
PROJ="$(api POST /api/projects "$(jq -nc '{name:"cloud-chat-rate proj"}')" | jq -r '.id // ""')"
[[ -n "$PROJ" ]] || { echo "project create failed" >&2; exit 1; }
# loadChatContext requires inquiry_landing_enabled (defaults OFF — link-free
# cold mail) AND a non-empty chat brief (inquiry_chat_brief is NULL by default).
psql_local "UPDATE project_settings SET inquiry_landing_enabled = true, inquiry_chat_brief = 'E2E chat brief' WHERE project_id = '$PROJ' AND tenant_id = '$T';" > /dev/null

P0="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJ" --arg d "e2e-chat-rate-$TS.example" \
  '{projectId:$pid, prospects:[{organizationDomain:$d, organizationName:"Chat Org", organizationWebsiteUrl:("https://"+$d),
    country:"US", countrySource:"manual", name:"Chat P0", overview:"seed", websiteUrl:("https://"+$d+"/a"),
    email:("p0@"+$d), matchReason:"seed"}]}')" | jq -r '.insertedIds[0] // empty')"
[[ -n "$P0" ]] || { echo "prospect register failed" >&2; exit 1; }

# Insert with a unique body marker, then resolve the id by SELECT (psql -c with
# RETURNING also prints the "INSERT 0 1" command tag, which would corrupt $OLOG).
OLOG_MARK="e2e-chat-rate-olog-$TS"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  VALUES ('$T', '$PROJ', $P0, 'email', '$OLOG_MARK', 'pending_review', NOW());" > /dev/null
OLOG="$(psql_local "SELECT id FROM outreach_logs WHERE tenant_id='$T' AND body='$OLOG_MARK' LIMIT 1;")"
[[ -n "$OLOG" ]] || { echo "outreach_log seed failed" >&2; exit 1; }

psql_local "INSERT INTO inquiry_tokens (short_id, tenant_id, prospect_id, outreach_log_id, created_at)
  VALUES ('$SHORT', '$T', $P0, $OLOG, NOW());" > /dev/null

# Target session: OPEN, 0 turns, recently opened (not idle) — every pre-rate
# gate (turn cap, plan quota) passes, so the rate gate is what fires.
psql_local "INSERT INTO inquiry_sessions (tenant_id, prospect_id, outreach_log_id, short_id, outcome, chat_turns_used, opened_at)
  VALUES ('$T', $P0, $OLOG, '$SHORT', 'opened', 0, NOW());" > /dev/null
say "target session: open, 0 turns, short_id=$SHORT"

step "reserve-first: one slot below the cap, the POST increments regardless of the OpenAI outcome"
psql_local "INSERT INTO chat_rate_windows (tenant_id, scope, key, window_start, used)
  VALUES ('$T', 'inquiry_link', '$SHORT', $WINDOW_SQL, 14);" > /dev/null
CODE="$(post_msg "$SHORT" "hello, is this product a fit for us?")"
RATE429="no"; [[ "$CODE" == "429" ]] && RATE429="yes"
assert_eq "POST one under the cap is not rate-limited (got $CODE)" "$RATE429" "no"
assert_eq "  slot was taken before the OpenAI call (used 14 → 15)" "$(rate_used inquiry_link "$SHORT")" "15"

step "at the cap → 429 pre-OpenAI, and used never exceeds the limit"
CODE="$(post_msg "$SHORT" "one more question")"; BODY="$(api_body)"
assert_eq "POST at the per-link daily cap → 429" "$CODE" "429"
assert_eq "  error = Chat message limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Chat message limit reached"
assert_eq "  detail names the daily limit and the meeting button" "$(echo "$BODY" | jq -r '.detail // ""')" \
  'This conversation has reached today'\''s message limit. Use the "Request meeting" button, or come back tomorrow.'
assert_eq "  conditional upsert skipped the increment at the cap (used stays 15)" "$(rate_used inquiry_link "$SHORT")" "15"

step "preview chat: per-tenant daily cap → 429 under the app_rls role (RLS + GRANT exercised)"
psql_local "INSERT INTO chat_rate_windows (tenant_id, scope, key, window_start, used)
  VALUES ('$T', 'preview', '$T', $WINDOW_SQL, 100);" > /dev/null
CODE="$(api_status POST /api/inquiry/preview/message "$(jq -nc --arg pid "$PROJ" '{projectId:$pid, message:"preview hello"}')")"
BODY="$(api_body)"
assert_eq "POST preview message at the per-tenant daily cap → 429" "$CODE" "429"
assert_eq "  error = Preview chat daily limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Preview chat daily limit reached"
assert_eq "  used stays at the cap (100)" "$(rate_used preview "$T")" "100"

cloud_summary
