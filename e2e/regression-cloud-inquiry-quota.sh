#!/usr/bin/env bash
# Cloud-edition regression: inquiry-chat plan quota (INQUIRY_CHAT_LIMITS in
# services/plan-limits.ts, enforced in services/inquiry-chat.ts runInquiryChat).
#
# The free-tier lifetime cap (25 chat turns, SUM over the tenant's
# inquiry_sessions) only binds on a LEADACE_EDITION=cloud worker. The quota gate
# runs BEFORE the OpenAI call, so the blocked path is reachable with no LLM
# round-trip and no cost. The happy path (a turn that succeeds + increments)
# needs a live OpenAI call and is NOT exercised here.
#
# Setup nuance: runInquiryChat checks the per-session hard cap
# (INQUIRY_CHAT_TURNS_MAX=5) BEFORE the plan quota. To reach the plan-quota 403
# we keep the TARGET session under 5 turns and park the rest of the 25 on a
# separate CLOSED filler session — closed sessions still count toward the
# lifetime SUM (no closed_at filter in getRemainingChatQuota) but are invisible
# to loadChatContext (which requires an open session). All of inquiry_tokens /
# inquiry_sessions / the outreach_log FK chain is seeded directly via psql.
#
# Targets the cloud worker on :8789 (override API_URL); start it with
# ./e2e/cloud-edition-up.sh.
#
# Usage:
#   ./e2e/regression-cloud-inquiry-quota.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-inquiry-quota.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-chat-$TS@example.com"
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

step "seed the inquiry FK chain (project → prospect → outreach_log → token → sessions)"
PROJ="$(api POST /api/projects "$(jq -nc '{name:"cloud-chat proj"}')" | jq -r '.id // ""')"
[[ -n "$PROJ" ]] || { echo "project create failed" >&2; exit 1; }
# loadChatContext requires inquiry_landing_enabled (defaults OFF — link-free
# cold mail) AND a non-empty chat brief (inquiry_chat_brief is NULL by default).
psql_local "UPDATE project_settings SET inquiry_landing_enabled = true, inquiry_chat_brief = 'E2E chat brief' WHERE project_id = '$PROJ' AND tenant_id = '$T';" > /dev/null

P0="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJ" --arg d "e2e-chat-$TS.example" \
  '{projectId:$pid, prospects:[{organizationDomain:$d, organizationName:"Chat Org", organizationWebsiteUrl:("https://"+$d),
    country:"US", countrySource:"manual", name:"Chat P0", overview:"seed", websiteUrl:("https://"+$d+"/a"),
    email:("p0@"+$d), matchReason:"seed"}]}')" | jq -r '.insertedIds[0] // empty')"
[[ -n "$P0" ]] || { echo "prospect register failed" >&2; exit 1; }

# Insert with a unique body marker, then resolve the id by SELECT (psql -c with
# RETURNING also prints the "INSERT 0 1" command tag, which would corrupt $OLOG).
OLOG_MARK="e2e-chat-olog-$TS"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  VALUES ('$T', '$PROJ', $P0, 'email', '$OLOG_MARK', 'pending_review', NOW());" > /dev/null
OLOG="$(psql_local "SELECT id FROM outreach_logs WHERE tenant_id='$T' AND body='$OLOG_MARK' LIMIT 1;")"
[[ -n "$OLOG" ]] || { echo "outreach_log seed failed" >&2; exit 1; }

psql_local "INSERT INTO inquiry_tokens (short_id, tenant_id, prospect_id, outreach_log_id, created_at)
  VALUES ('$SHORT', '$T', $P0, $OLOG, NOW());" > /dev/null

# Target session: OPEN, 0 turns, recently opened (not idle).
psql_local "INSERT INTO inquiry_sessions (tenant_id, prospect_id, outreach_log_id, short_id, outcome, chat_turns_used, opened_at)
  VALUES ('$T', $P0, $OLOG, '$SHORT', 'opened', 0, NOW());" > /dev/null
say "target session: open, 0 turns, short_id=$SHORT"

step "free lifetime chat cap (25 turns) binds → 403 before the OpenAI call"
# Filler session: CLOSED, 25 turns → tenant lifetime SUM hits the cap, but
# loadChatContext (open-only) still resolves the 0-turn target session.
psql_local "INSERT INTO inquiry_sessions (tenant_id, prospect_id, outreach_log_id, short_id, outcome, chat_turns_used, opened_at, closed_at)
  VALUES ('$T', $P0, $OLOG, '$SHORT', 'opened', 25, NOW(), NOW());" > /dev/null
SUM="$(psql_local "SELECT COALESCE(SUM(chat_turns_used),0)::int FROM inquiry_sessions WHERE tenant_id='$T';")"
assert_eq "tenant lifetime chat turns summed to the cap (25)" "$SUM" "25"

CODE="$(post_msg "$SHORT" "hello, is this product a fit for us?")"; BODY="$(api_body)"
assert_eq "POST inquiry message at the chat cap → 403" "$CODE" "403"
assert_eq "  error = Chat limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Chat limit reached"
assert_eq "  detail = free lifetime chat message" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your free plan inquiry-chat lifetime limit (25 turns) is reached. Upgrade to enable more chat conversations."

step "per-session hard cap (5) takes precedence over the plan quota (both pre-OpenAI)"
# Bumping the TARGET session to the per-session cap makes the 5-turn gate fire
# first (UNPROCESSABLE 422), proving the gate ordering and that we're hitting
# real gates — not an OpenAI failure masquerading as the block.
psql_local "UPDATE inquiry_sessions SET chat_turns_used = 5 WHERE short_id = '$SHORT' AND closed_at IS NULL;" > /dev/null
CODE="$(post_msg "$SHORT" "another question")"; BODY="$(api_body)"
assert_eq "target session at per-session cap → 422 (before the quota 403)" "$CODE" "422"
assert_eq "  error = Chat turn limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Chat turn limit reached"

step "negative control: a revoked token collapses to 404 (loadChatContext gate)"
psql_local "UPDATE inquiry_sessions SET chat_turns_used = 0 WHERE short_id = '$SHORT' AND closed_at IS NULL;" > /dev/null
psql_local "UPDATE inquiry_tokens SET revoked_at = NOW() WHERE short_id = '$SHORT';" > /dev/null
CODE="$(post_msg "$SHORT" "after revoke")"
assert_eq "revoked token → 404 (not the quota 403)" "$CODE" "404"

cloud_summary
