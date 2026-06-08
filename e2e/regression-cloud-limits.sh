#!/usr/bin/env bash
# Cloud-edition regression: plan project-count + prospect-registration limits
# (coverage-audit §2 gap #20 — services/projects.ts maxProjects,
# services/prospect-import.ts maxProspects budget).
#
# These caps only bind on a LEADACE_EDITION=cloud worker (self-hosted resolves
# every tenant to 'unlimited'). Targets the cloud worker on :8789 (override with
# API_URL); start it with ./e2e/cloud-edition-up.sh.
#
# Provisions a throwaway tenant, then asserts:
#   A. free maxProjects=1   — 2nd project create → 403; N+1 allowed after delete
#   B. pro  maxProjects=5   — 6th project create → 403
#   C. free maxProspects=500 budget — mid-batch truncation to remaining budget
#      (rows past budget skipped reason 'plan_limit') and full 403 rejection at 0
#   D. budget basis — prospects saved WITHOUT a projectId still count (the count
#      is over the prospects table, not project_prospects)
#
# Usage:
#   ./e2e/regression-cloud-limits.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-limits.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-limits-$TS@example.com"
source "$REPO_ROOT/e2e/lib-cloud.sh"

trap cloud_teardown EXIT

require_jq
API_OUT="$(mktemp)"
cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"

step "A. free plan: maxProjects=1 binds"
cloud_seed_plan "$T" free

P1="$(api POST /api/projects "$(jq -nc '{name:"cloud-limits P1"}')" | jq -r '.id // ""')"
[[ -n "$P1" ]] || { echo "first project create failed" >&2; exit 1; }
assert_eq "1st project create → 201 (id present)" "$([[ -n "$P1" ]] && echo yes)" "yes"

CODE="$(api_status POST /api/projects "$(jq -nc '{name:"cloud-limits P2"}')")"
BODY="$(api_body)"
assert_eq "2nd project create → 403" "$CODE" "403"
assert_eq "  error = Project limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Project limit reached"
assert_eq "  detail names the free 1-project cap" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your free plan allows 1 project(s). Delete an existing project or upgrade your plan."

api DELETE "/api/projects/$P1" > /dev/null
CODE="$(api_status POST /api/projects "$(jq -nc '{name:"cloud-limits P-after-delete"}')")"
assert_eq "N+1 project create allowed after delete → 201" "$CODE" "201"
# Clean the slate for part B: delete every project this tenant now holds.
for pid in $(api GET /api/projects | jq -r '.projects[]?.id'); do
  api DELETE "/api/projects/$pid" > /dev/null
done
assert_eq "project list empty before part B" "$(api GET /api/projects | jq -r '.projects | length')" "0"

step "B. pro plan: maxProjects=5 binds"
cloud_seed_plan "$T" pro
for i in 1 2 3 4 5; do
  CODE="$(api_status POST /api/projects "$(jq -nc --arg n "pro P$i" '{name:$n}')")"
  assert_eq "pro project $i/5 → 201" "$CODE" "201"
done
CODE="$(api_status POST /api/projects "$(jq -nc '{name:"pro P6"}')")"
BODY="$(api_body)"
assert_eq "6th project create → 403" "$CODE" "403"
assert_eq "  detail names the pro 5-project cap" "$(echo "$BODY" | jq -r '.detail // ""')" \
  "Your pro plan allows 5 project(s). Delete an existing project or upgrade your plan."

# Tear down projects so part C starts clean (prospect budget is independent of
# projects, but keeps the tenant tidy).
for pid in $(api GET /api/projects | jq -r '.projects[]?.id'); do
  api DELETE "/api/projects/$pid" > /dev/null
done

step "C/D. free plan: maxProspects=500 budget (counted on prospects table, no projectId needed)"
cloud_seed_plan "$T" free

# Register one prospect via the API (no projectId) to mint a valid organization
# we can hang the bulk psql-seeded rows off (prospects.organization_id is NOT
# NULL with a composite (org_id, tenant_id) FK).
SEED1="$(api POST /api/prospects/batch "$(jq -nc --arg d "e2e-budget-$TS.example" \
  '{prospects:[{organizationDomain:$d, organizationName:"Budget Org", organizationWebsiteUrl:("https://"+$d),
    name:"budget anchor", overview:"seed", websiteUrl:("https://"+$d+"/a"), email:("a@"+$d)}]}')")"
assert_eq "anchor prospect inserted (no projectId) =1" "$(echo "$SEED1" | jq -r '.inserted // 0')" "1"
PID1="$(echo "$SEED1" | jq -r '.insertedIds[0] // empty')"
ORG_ID="$(psql_local "SELECT organization_id FROM prospects WHERE id = $PID1 AND tenant_id = '$T';")"
[[ -n "$ORG_ID" ]] || { echo "could not resolve organization_id for anchor prospect" >&2; exit 1; }

# Bulk-seed to 498 total (1 anchor + 497). email NULL so the per-tenant unique
# email index is irrelevant; rows exist only to be counted.
psql_local "INSERT INTO prospects (tenant_id, name, organization_id, overview, website_url, do_not_contact, created_at, updated_at)
  SELECT '$T', 'budget-seed-'||g, $ORG_ID, 'seed', 'https://e2e-budget-$TS.example/'||g, false, NOW(), NOW()
  FROM generate_series(1, 497) AS g;" > /dev/null
COUNT="$(psql_local "SELECT count(*)::int FROM prospects WHERE tenant_id = '$T';")"
assert_eq "tenant prospect count seeded to 498" "$COUNT" "498"

# A 100-row batch with budget=2 → first 2 inserted, remaining 98 skipped 'plan_limit'.
BATCH100="$(jq -nc --arg ts "$TS" '{prospects: [range(0;100) | {
    organizationDomain: ("e2e-bud100-\($ts)-\(.).example"),
    organizationName: "Bud100",
    organizationWebsiteUrl: ("https://e2e-bud100-\($ts)-\(.).example"),
    name: ("bud100-\(.)"), overview: "seed",
    websiteUrl: ("https://e2e-bud100-\($ts)-\(.).example/a"),
    email: ("bud100-\(.)@e2e-bud100-\($ts).example")
  }]}')"
CODE="$(api_status POST /api/prospects/batch "$BATCH100")"
BODY="$(api_body)"
assert_eq "mid-batch truncation → 2xx" "$([[ "$CODE" =~ ^2 ]] && echo ok)" "ok"
assert_eq "  inserted = remaining budget (2)" "$(echo "$BODY" | jq -r '.inserted // -1')" "2"
assert_eq "  skipped = 98" "$(echo "$BODY" | jq -r '.skipped // -1')" "98"
assert_eq "  all skips are reason=plan_limit" \
  "$(echo "$BODY" | jq -r '[.skippedDetails[]?|select(.reason=="plan_limit")]|length')" "98"
assert_eq "tenant prospect count now exactly at the 500 cap" \
  "$(psql_local "SELECT count(*)::int FROM prospects WHERE tenant_id = '$T';")" "500"

# At budget 0 the whole batch is rejected with FORBIDDEN (403) and every row
# reported as plan_limit (skippedDetails comes from the err `extra`).
BATCH5="$(jq -nc --arg ts "$TS" '{prospects: [range(0;5) | {
    organizationDomain: ("e2e-bud5-\($ts)-\(.).example"),
    organizationName: "Bud5",
    organizationWebsiteUrl: ("https://e2e-bud5-\($ts)-\(.).example"),
    name: ("bud5-\(.)"), overview: "seed",
    websiteUrl: ("https://e2e-bud5-\($ts)-\(.).example/a"),
    email: ("bud5-\(.)@e2e-bud5-\($ts).example")
  }]}')"
CODE="$(api_status POST /api/prospects/batch "$BATCH5")"
BODY="$(api_body)"
assert_eq "budget 0: batch → 403" "$CODE" "403"
assert_eq "  error = Prospect registration limit reached" "$(echo "$BODY" | jq -r '.error // ""')" "Prospect registration limit reached"
assert_eq "  inserted = 0" "$(echo "$BODY" | jq -r '.inserted // -1')" "0"
assert_eq "  skipped = 5, all plan_limit" \
  "$(echo "$BODY" | jq -r '[.skippedDetails[]?|select(.reason=="plan_limit")]|length')" "5"
assert_eq "tenant prospect count unchanged at 500 (nothing inserted)" \
  "$(psql_local "SELECT count(*)::int FROM prospects WHERE tenant_id = '$T';")" "500"

cloud_summary
