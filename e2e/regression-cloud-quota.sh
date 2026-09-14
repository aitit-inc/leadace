#!/usr/bin/env bash
# Cloud-edition regression: prospect quota enforcement — services/plan-limits.ts
# (a prospect counts once, at its first send; follow-ups are free) + the
# enforcement call-sites in services/outreach.ts and listReachable.
#
# buildProspectQuota's arithmetic is unit-tested; this exercises the
# end-to-end binding that only fires on a LEADACE_EDITION=cloud worker
# (self-hosted = every tenant 'unlimited', so quota never binds). Targets the
# cloud worker on :8789 (override API_URL); start it with ./e2e/cloud-edition-up.sh.
#
# Provisions a throwaway tenant, seeds 'sent' outreach_logs via psql, then
# asserts: the free lifetime allowance (30) refuses a first touch but not a
# follow-up, a follow-up never counts, the starter period allowance (100)
# anchors at current_period_start, an in-flight pre_send reservation counts,
# and overage lifts the refusal.
#
# Usage:
#   ./e2e/regression-cloud-quota.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-quota.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-quota-$TS@example.com"
source "$REPO_ROOT/e2e/lib-cloud.sh"

trap cloud_teardown EXIT

require_jq
API_OUT="$(mktemp)"
cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"

# Compliance must pass so a send reaches the quota guard (order in
# services/outreach.ts: compliance → DNC → quota → country → pre_send INSERT).
api PUT /api/tenant-settings '{"legalName":"E2E Quota Co","physicalAddress":"1 E2E St, Test City","defaultSenderCountry":"US"}' > /dev/null

step "seed project + 31 reachable US prospects"
PROJ="$(api POST /api/projects "$(jq -nc '{name:"cloud-quota proj"}')" | jq -r '.id // ""')"
[[ -n "$PROJ" ]] || { echo "project create failed" >&2; exit 1; }
# New projects default to draft; quota binds on the send path.
api PUT "/api/projects/$PROJ/settings" '{"outboundMode":"send"}' > /dev/null
SEED="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJ" --arg ts "$TS" \
  '{projectId:$pid, prospects: [range(0;31) | {
      organizationDomain: ("e2e-q-\($ts)-\(.).example"), organizationName: "Q Org",
      organizationWebsiteUrl: ("https://e2e-q-\($ts)-\(.).example"),
      country: "US", countrySource: "manual",
      name: ("Q-\(.)"), overview: "seed", websiteUrl: ("https://e2e-q-\($ts)-\(.).example/a"),
      email: ("q-\(.)@e2e-q-\($ts).example"), matchReason: "seed"
  }]}')")"
assert_eq "31 reachable prospects registered" "$(echo "$SEED" | jq -r '.inserted // 0')" "31"
P_FIRST="$(echo "$SEED" | jq -r '.insertedIds[0]')"
P_LAST="$(echo "$SEED" | jq -r '.insertedIds[29]')"
P_NEW="$(echo "$SEED" | jq -r '.insertedIds[30]')"
assert_eq "API-registered prospects are brought_in (found allowance untouched)" \
  "$(psql_local "SELECT count(*)::int FROM prospects WHERE tenant_id='$T' AND origin='found';")" "0"

reset_outreach() { psql_local "DELETE FROM outreach_logs WHERE tenant_id='$T';" > /dev/null; }
# seed_first_touches <count> <sent_at_sql> — one counted 'sent' row for each of
# the first N prospects (never P_NEW), so N distinct prospects are contacted.
seed_first_touches() {
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
    SELECT '$T', '$PROJ', id, 'email', 'e2e quota seed', 'sent', $2
    FROM prospects WHERE tenant_id='$T' AND id <> $P_NEW ORDER BY id LIMIT $1;" > /dev/null
}
send_body() { jq -nc --arg pid "$PROJ" --argjson prid "$1" \
  '{projectId:$pid, prospectId:$prid, subject:"quota probe", body:"body"}'; }
rec_body()  { jq -nc --arg pid "$PROJ" --argjson prid "$1" \
  '{projectId:$pid, prospectId:$prid, channel:"email", subject:"quota probe", body:"body", status:"sent"}'; }

LIFETIME_MSG="Your free plan includes 30 prospects in total and all 30 have been contacted. Follow-ups still go out. Upgrade to reach new prospects."
MONTHLY_MSG="Your starter plan includes 100 prospects per billing period and all 100 have been contacted. Follow-ups still go out. New prospects resume next period; enable overage or upgrade on the plans page to continue now."

step "1. free lifetime allowance (30) refuses a first touch, not a follow-up"
cloud_seed_plan "$T" free
reset_outreach
seed_first_touches 30 "NOW()"

CODE="$(api_status POST /api/outreach/send-and-record "$(send_body "$P_NEW")")"; BODY="$(api_body)"
assert_eq "send-and-record first touch at the allowance → 403" "$CODE" "403"
assert_eq "  error = Prospect limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Prospect limit reached"
assert_eq "  detail = lifetime message" "$(echo "$BODY" | jq -r '.detail // ""')" "$LIFETIME_MSG"
assert_eq "  blocked send allocated NO pre_send row" \
  "$(psql_local "SELECT count(*)::int FROM outreach_logs WHERE tenant_id='$T' AND status='pre_send';")" "0"

CODE="$(api_status POST /api/outreach "$(rec_body "$P_NEW")")"; BODY="$(api_body)"
assert_eq "record_outreach(sent) first touch at the allowance → 403" "$CODE" "403"
assert_eq "  record_outreach detail = lifetime message" "$(echo "$BODY" | jq -r '.detail // ""')" "$LIFETIME_MSG"

CODE="$(api_status POST /api/outreach "$(rec_body "$P_FIRST")")"
assert_eq "record_outreach(sent) follow-up to a contacted prospect → 201" "$CODE" "201"

REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=50")"
assert_eq "reachable at the allowance is not blocked (follow-ups only)" "$(echo "$REACH" | jq -r '.outboundBlocked')" "false"
assert_eq "  reachable.quota.contacted.remaining = 0" "$(echo "$REACH" | jq -r '.quota.contacted.remaining')" "0"
assert_eq "  reachable.quota.window = lifetime" "$(echo "$REACH" | jq -r '.quota.window')" "lifetime"
assert_eq "  reachable lists only contacted prospects (never the new one)" \
  "$(echo "$REACH" | jq -r --argjson p "$P_NEW" '[.prospects[] | select(.prospectId == $p)] | length')" "0"
assert_eq "  reachable.message = lifetime message" "$(echo "$REACH" | jq -r '.message // ""')" "$LIFETIME_MSG"

PLAN="$(api GET /api/me/plan)"
assert_eq "/me/plan counts 30 contacted (the follow-up row did not add one)" "$(echo "$PLAN" | jq -r '.quota.contacted.used')" "30"
assert_eq "  /me/plan found.used = 0" "$(echo "$PLAN" | jq -r '.quota.found.used')" "0"

step "2. a follow-up never counts: 29 prospects + 5 extra rows on one = 29 used"
reset_outreach
seed_first_touches 29 "NOW()"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  SELECT '$T', '$PROJ', $P_FIRST, 'email', 'e2e follow-up', 'sent', NOW() FROM generate_series(1, 5);" > /dev/null
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "reachable.quota.contacted.used = 29" "$(echo "$REACH" | jq -r '.quota.contacted.used')" "29"
assert_eq "the draw is not sized by the allowance (follow-ups fill it)" "$(echo "$REACH" | jq -r '.prospects | length')" "10"
assert_eq "  at most 1 never-contacted prospect among the drawn" \
  "$(echo "$REACH" | jq -r --argjson a "$P_LAST" --argjson b "$P_NEW" '[.prospects[] | select(.prospectId == $a or .prospectId == $b)] | length <= 1')" "true"

step "3. in-flight pre_send reservation counts as a first touch"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  SELECT '$T', '$PROJ', id, 'email', 'e2e inflight', 'pre_send', NOW()
  FROM prospects WHERE tenant_id='$T' AND id <> $P_NEW ORDER BY id DESC LIMIT 1;" > /dev/null
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "fresh pre_send row on a 30th prospect drops remaining to 0" "$(echo "$REACH" | jq -r '.quota.contacted.remaining')" "0"
CODE="$(api_status POST /api/outreach/send-and-record "$(send_body "$P_NEW")")"
assert_eq "send-and-record first touch → 403 while the reservation is in flight" "$CODE" "403"

step "4. starter period allowance (100) anchors at current_period_start"
cloud_seed_plan "$T" starter
reset_outreach
# 31 prospects seeded; the remaining 70 first touches come from tenant-only
# prospects (no project link) — the allowance is tenant-wide.
api POST /api/prospects/batch "$(jq -nc --arg ts "$TS" \
  '{prospects: [range(0;70) | {
      organizationDomain: ("e2e-qt-\($ts)-\(.).example"), organizationName: "QT Org",
      organizationWebsiteUrl: ("https://e2e-qt-\($ts)-\(.).example"),
      name: ("QT-\(.)"), overview: "seed", websiteUrl: ("https://e2e-qt-\($ts)-\(.).example/a"),
      email: ("qt-\(.)@e2e-qt-\($ts).example")
  }]}')" > /dev/null
seed_first_touches 100 "NOW()"
CODE="$(api_status POST /api/outreach/send-and-record "$(send_body "$P_NEW")")"; BODY="$(api_body)"
assert_eq "send-and-record first touch at the period allowance → 403" "$CODE" "403"
assert_eq "  detail = period message" "$(echo "$BODY" | jq -r '.detail // ""')" "$MONTHLY_MSG"
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "  reachable.quota.window = monthly" "$(echo "$REACH" | jq -r '.quota.window')" "monthly"

psql_local "UPDATE outreach_logs SET sent_at = NOW() - INTERVAL '40 days' WHERE tenant_id='$T';" > /dev/null
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "first touches before the period start do not count" "$(echo "$REACH" | jq -r '.quota.contacted.used')" "0"

step "5. overage lifts the refusal on a paid plan"
psql_local "UPDATE outreach_logs SET sent_at = NOW() WHERE tenant_id='$T';" > /dev/null
psql_local "UPDATE tenant_plans SET overage_enabled = true WHERE tenant_id='$T';" > /dev/null
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=50")"
assert_eq "reachable.quota.overageEnabled = true" "$(echo "$REACH" | jq -r '.quota.overageEnabled')" "true"
assert_eq "  remaining still reports 0" "$(echo "$REACH" | jq -r '.quota.contacted.remaining')" "0"
assert_eq "  first touches are not capped with overage on" \
  "$(echo "$REACH" | jq -r --argjson p "$P_NEW" '[.prospects[] | select(.prospectId == $p)] | length')" "1"
CODE="$(api_status POST /api/outreach "$(rec_body "$P_NEW")")"
assert_eq "record_outreach(sent) first touch past the allowance → 201 with overage" "$CODE" "201"

cloud_summary
