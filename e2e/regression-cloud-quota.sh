#!/usr/bin/env bash
# Cloud-edition regression: outreach quota enforcement — services/plan-limits.ts
# windows + the enforcement call-sites in services/outreach.ts and listReachable.
#
# selectOutreachQuota's window math is unit-tested; this exercises the
# end-to-end binding that only fires on a LEADACE_EDITION=cloud worker
# (self-hosted = every tenant 'unlimited', so quota never binds). Targets the
# cloud worker on :8789 (override API_URL); start it with ./e2e/cloud-edition-up.sh.
#
# Provisions a throwaway tenant, seeds 'sent' outreach_logs to the cap via
# psql, then asserts each window (free daily / free lifetime / starter monthly)
# binds end-to-end and that the effectiveLimit clamp counts in-flight pre_send
# rows toward used (concurrent-race guard).
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

step "seed project + reachable US prospects"
PROJ="$(api POST /api/projects "$(jq -nc '{name:"cloud-quota proj"}')" | jq -r '.id // ""')"
[[ -n "$PROJ" ]] || { echo "project create failed" >&2; exit 1; }
# New projects default to draft; quota binds on the send path.
api PUT "/api/projects/$PROJ/settings" '{"outboundMode":"send"}' > /dev/null
SEED="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJ" --arg ts "$TS" \
  '{projectId:$pid, prospects: [range(0;5) | {
      organizationDomain: ("e2e-q-\($ts)-\(.).example"), organizationName: "Q Org",
      organizationWebsiteUrl: ("https://e2e-q-\($ts)-\(.).example"),
      country: "US", countrySource: "manual",
      name: ("Q-\(.)"), overview: "seed", websiteUrl: ("https://e2e-q-\($ts)-\(.).example/a"),
      email: ("q-\(.)@e2e-q-\($ts).example"), matchReason: "seed"
  }]}')")"
assert_eq "5 reachable prospects registered" "$(echo "$SEED" | jq -r '.inserted // 0')" "5"
P0="$(echo "$SEED" | jq -r '.insertedIds[0]')"

reset_outreach() { psql_local "DELETE FROM outreach_logs WHERE tenant_id='$T';" > /dev/null; }
# seed_sent <count> <sent_at_sql>  — append N counted 'sent' rows against P0.
seed_sent() {
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
    SELECT '$T', '$PROJ', $P0, 'email', 'e2e quota seed', 'sent', $2
    FROM generate_series(1, $1);" > /dev/null
}
send_body() { jq -nc --arg pid "$PROJ" --argjson prid "$P0" \
  '{projectId:$pid, prospectId:$prid, subject:"quota probe", body:"body"}'; }
rec_body()  { jq -nc --arg pid "$PROJ" --argjson prid "$P0" \
  '{projectId:$pid, prospectId:$prid, channel:"email", subject:"quota probe", body:"body", status:"sent"}'; }

step "1. free daily cap (5/day) binds end-to-end"
cloud_seed_plan "$T" free
reset_outreach
seed_sent 5 "NOW()"

CODE="$(api_status POST /api/outreach/send-and-record "$(send_body)")"; BODY="$(api_body)"
assert_eq "send-and-record at daily cap → 403" "$CODE" "403"
assert_eq "  error = Outreach limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Outreach limit reached"
assert_eq "  detail = daily message" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your free plan allows 5 outreach per day. Try again tomorrow or upgrade for higher limits."
assert_eq "  blocked send allocated NO pre_send row" \
  "$(psql_local "SELECT count(*)::int FROM outreach_logs WHERE tenant_id='$T' AND status='pre_send';")" "0"

CODE="$(api_status POST /api/outreach "$(rec_body)")"; BODY="$(api_body)"
assert_eq "record_outreach(sent) at daily cap → 403" "$CODE" "403"
assert_eq "  record_outreach detail = daily message" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your free plan allows 5 outreach per day. Try again tomorrow or upgrade for higher limits."

REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "reachable at daily cap → empty list" "$(echo "$REACH" | jq -r '.prospects | length')" "0"
assert_eq "  reachable.quota.remaining = 0" "$(echo "$REACH" | jq -r '.quota.remaining')" "0"
assert_eq "  reachable.quota.bindingConstraint = daily" "$(echo "$REACH" | jq -r '.quota.bindingConstraint')" "daily"
assert_eq "  reachable.message = daily message" "$(echo "$REACH" | jq -r '.message // ""')" \
  "Your free plan allows 5 outreach per day. Try again tomorrow or upgrade for higher limits."

step "2. free lifetime cap (100) binds (daily window clear)"
reset_outreach
seed_sent 100 "NOW() - INTERVAL '2 days'"  # before today's UTC midnight → daily=0, lifetime=100
CODE="$(api_status POST /api/outreach/send-and-record "$(send_body)")"; BODY="$(api_body)"
assert_eq "send-and-record at lifetime cap → 403" "$CODE" "403"
assert_eq "  detail = lifetime message" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your free plan lifetime limit (100) is reached. Upgrade to keep sending."
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "  reachable.quota.bindingConstraint = lifetime" "$(echo "$REACH" | jq -r '.quota.bindingConstraint')" "lifetime"

step "3. starter monthly cap (1500) binds (anchored at current_period_start)"
cloud_seed_plan "$T" starter
reset_outreach
seed_sent 1500 "NOW()"
CODE="$(api_status POST /api/outreach/send-and-record "$(send_body)")"; BODY="$(api_body)"
assert_eq "send-and-record at monthly cap → 403" "$CODE" "403"
assert_eq "  detail = monthly message" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your starter plan allows 1500 outreach this month. Upgrade your plan to continue."
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "  reachable.quota.bindingConstraint = monthly" "$(echo "$REACH" | jq -r '.quota.bindingConstraint')" "monthly"

step "4. effectiveLimit clamp + pre_send in-flight counting (free)"
cloud_seed_plan "$T" free
reset_outreach
seed_sent 3 "NOW()"   # daily used 3 → remaining 2 (of 5)
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "reachable.quota.remaining = 2" "$(echo "$REACH" | jq -r '.quota.remaining')" "2"
assert_eq "reachable returns at most remaining (effectiveLimit=min(10,2))" \
  "$(echo "$REACH" | jq -r '.prospects | length')" "2"

# An in-flight pre_send reservation (within the 30-min TTL) counts toward used.
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  VALUES ('$T', '$PROJ', $P0, 'email', 'e2e inflight', 'pre_send', NOW());" > /dev/null
REACH="$(api GET "/api/projects/$PROJ/prospects/reachable?limit=10")"
assert_eq "fresh pre_send row drops remaining to 1 (counts toward used)" \
  "$(echo "$REACH" | jq -r '.quota.remaining')" "1"
assert_eq "effectiveLimit re-clamps to 1" "$(echo "$REACH" | jq -r '.prospects | length')" "1"

cloud_summary
