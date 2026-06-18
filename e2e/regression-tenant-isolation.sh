#!/usr/bin/env bash
# Net-new regression for cross-tenant RLS isolation with a REAL second tenant
# (coverage-audit §2 gap #13; also covers the #19 account-deletion blast radius).
#
# The single load-bearing multi-tenancy guarantee: tenant A cannot read or write
# tenant B's rows. rlsMiddleware pins each request to its tenant via
# `SET LOCAL ROLE app_rls` + set_config('app.tenant_id', ..., true) inside a
# transaction (middleware/rls.ts), and the tenant_isolation RLS policy
# (drizzle/0001_rls_policies.sql) filters every tenant-scoped table.
#
# Verified live: (1) READ — B's lists exclude A's project/prospect (filtered, not
# an error); (2) WRITE — B can't delete/seed into A's project (404, requireProject
# can't SELECT the RLS-hidden row); (3) the raw WITH CHECK backstop rejects an
# INSERT with a foreign tenant_id at the DB layer; (4) pooled-connection reset —
# sequential A-then-B on the same worker each see only their own tenant; (5)
# account deletion of B removes ONLY B's tenant, leaving A fully intact.
#
# Provisions tenant B by minting a real auth user via the GoTrue Admin API
# (service-role key from backend/.dev.vars). Curl-only, cleans up (incl. user B).
#
# Usage:
#   ./e2e/regression-tenant-isolation.sh
#   SKIP_CLEANUP=1 ./e2e/regression-tenant-isolation.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

TS="$(date +%s)"
RUN_TAG="e2e-rls-$TS"
EMAIL_B="e2e-rls-b-$TS@example.com"

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

# Tokened request: token is the explicit first arg (2-tenant test).
api() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -X "$method" -H "Authorization: Bearer $tok" "$API_URL$path"
  fi
}

API_OUT=""
api_status() {
  local tok="$1" method="$2" path="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o "$API_OUT" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $tok" "$API_URL$path"
  fi
}
api_body() { cat "$API_OUT"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

dotenv() { grep -E "^$1=" "$REPO_ROOT/backend/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

require_jq
API_OUT="$(mktemp)"
SVC="$(dotenv SUPABASE_SERVICE_ROLE_KEY)"
SUPA_URL="$(dotenv SUPABASE_URL)"; SUPA_URL="${SUPA_URL:-http://127.0.0.1:54321}"
[[ -n "$SVC" ]] || { echo "SUPABASE_SERVICE_ROLE_KEY not found in backend/.dev.vars" >&2; exit 1; }

TOKEN_A="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN_A" ]] || { echo "failed to mint JWT for tenant A" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

USER_A_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_A="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_A_ID' LIMIT 1;")"
[[ -n "$TENANT_A" ]] || { echo "no tenant for user A — sign in once via the frontend first" >&2; exit 1; }
say "tenant_a=$TENANT_A"

USER_B_ID=""
restore_and_exit() {
  local rc=$?
  rm -f "${API_OUT:-}" 2>/dev/null || true
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving projects, rows, and user B ($EMAIL_B) in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  [[ -n "${PROJECT_A_ID:-}" ]] && api "$TOKEN_A" DELETE "/api/projects/$PROJECT_A_ID" > /dev/null 2>&1 || true
  [[ -n "${TOKEN_B:-}" && -n "${PROJECT_B_ID:-}" ]] && api "$TOKEN_B" DELETE "/api/projects/$PROJECT_B_ID" > /dev/null 2>&1 || true
  psql_local "DELETE FROM prospects WHERE email LIKE '%$RUN_TAG%';" > /dev/null 2>&1 || true
  psql_local "DELETE FROM organizations WHERE domain LIKE '$RUN_TAG-%';" > /dev/null 2>&1 || true
  # Delete the synthetic auth user B (cascades any remaining tenant rows). Tolerant
  # of 404 if the account-deletion leg already removed the tenant (auth.users row
  # survives on self-host, so this is still required).
  if [[ -n "$USER_B_ID" ]]; then
    curl -sS -X DELETE "$SUPA_URL/auth/v1/admin/users/$USER_B_ID" -H "Authorization: Bearer $SVC" -H "apikey: $SVC" > /dev/null 2>&1 || true
    say "deleted GoTrue user B"
  fi
  say "dropped run-tagged rows ($RUN_TAG)"
  exit "$rc"
}
trap restore_and_exit EXIT

step "provision tenant B (GoTrue admin user + mint JWT + auto-provision)"
CREATE_USER="$(curl -sS -X POST "$SUPA_URL/auth/v1/admin/users" \
  -H "Authorization: Bearer $SVC" -H "apikey: $SVC" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg e "$EMAIL_B" --arg p "e2e-pw-$TS" '{email:$e, email_confirm:true, password:$p}')")"
USER_B_ID="$(echo "$CREATE_USER" | jq -r '.id // ""')"
[[ -n "$USER_B_ID" && "$USER_B_ID" != "null" ]] || { echo "failed to create user B: $CREATE_USER" >&2; exit 1; }
say "user_b_id=$USER_B_ID ($EMAIL_B)"

TOKEN_B="$("$REPO_ROOT/e2e/mint-jwt.sh" --email "$EMAIL_B")"
[[ -n "$TOKEN_B" ]] || { echo "failed to mint JWT for tenant B" >&2; exit 1; }
# First authenticated hit auto-provisions B's tenant/tenant_members rows.
api "$TOKEN_B" GET /api/projects > /dev/null
TENANT_B="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_B_ID' LIMIT 1;")"
[[ -n "$TENANT_B" ]] || { echo "tenant B was not auto-provisioned" >&2; exit 1; }
say "tenant_b=$TENANT_B"
assert_eq "distinct tenants provisioned" "$(psql_local "SELECT ('$TENANT_A' <> '$TENANT_B');")" "t"

step "seed each tenant's private project + prospect"
PROJECT_A_ID="$(api "$TOKEN_A" POST /api/projects "$(jq -nc --arg n "$RUN_TAG-A project" '{name:$n}')" | jq -r '.id // ""')"
PROJECT_B_ID="$(api "$TOKEN_B" POST /api/projects "$(jq -nc --arg n "$RUN_TAG-B project" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_A_ID" && -n "$PROJECT_B_ID" ]] || { echo "project create failed (A=$PROJECT_A_ID B=$PROJECT_B_ID)" >&2; exit 1; }
SEED_A="$(api "$TOKEN_A" POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_A_ID" --argjson p "$(mkseed a)" '{projectId:$pid, prospects:[$p]}')")"
SEED_B="$(api "$TOKEN_B" POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_B_ID" --argjson p "$(mkseed b)" '{projectId:$pid, prospects:[$p]}')")"
assert_eq "A seed inserted=1" "$(echo "$SEED_A" | jq -r '.inserted // 0')" "1"
assert_eq "B seed inserted=1" "$(echo "$SEED_B" | jq -r '.inserted // 0')" "1"
PROSPECT_A_ID="$(echo "$SEED_A" | jq -r '.insertedIds[0] // empty')"
PROSPECT_B_ID="$(echo "$SEED_B" | jq -r '.insertedIds[0] // empty')"
[[ -n "$PROSPECT_A_ID" && -n "$PROSPECT_B_ID" ]] || { echo "could not resolve seeded prospect ids" >&2; exit 1; }
say "project_a=$PROJECT_A_ID prospect_a=$PROSPECT_A_ID | project_b=$PROJECT_B_ID prospect_b=$PROSPECT_B_ID"

step "READ isolation"
assert_eq "B's project list EXCLUDES A's project" \
  "$(api "$TOKEN_B" GET /api/projects | jq --arg id "$PROJECT_A_ID" '[.projects[]?|select(.id==$id)]|length')" "0"
assert_eq "A's project list CONTAINS A's project (positive control)" \
  "$(api "$TOKEN_A" GET /api/projects | jq --arg id "$PROJECT_A_ID" '[.projects[]?|select(.id==$id)]|length')" "1"
assert_eq "B reading A's project prospects → 404 (RLS hides project)" \
  "$(api_status "$TOKEN_B" GET "/api/projects/$PROJECT_A_ID/prospects?limit=50")" "404"
# /tenant/prospects returns rows keyed by `.id` (not `.prospectId`) ordered
# createdAt desc, limit 200 — narrow with ?q=<run tag> (matches the org name) so
# A's lone seeded row isn't buried under tenant A's existing prospects.
assert_eq "B's tenant-wide prospect list EXCLUDES A's prospect" \
  "$(api "$TOKEN_B" GET "/api/tenant/prospects?q=$RUN_TAG-a" | jq --argjson id "$PROSPECT_A_ID" '[.prospects[]?|select(.id==$id)]|length')" "0"
assert_eq "A's tenant-wide list CONTAINS A's prospect (positive control)" \
  "$(api "$TOKEN_A" GET "/api/tenant/prospects?q=$RUN_TAG-a" | jq --argjson id "$PROSPECT_A_ID" '[.prospects[]?|select(.id==$id)]|length')" "1"

step "WRITE isolation"
assert_eq "B deleting A's project → 404" "$(api_status "$TOKEN_B" DELETE "/api/projects/$PROJECT_A_ID")" "404"
assert_eq "A's project row still present" "$(psql_local "SELECT count(*)::int FROM projects WHERE id='$PROJECT_A_ID';")" "1"
assert_eq "B batch-seeding into A's project → 404 (requireProject hides it)" \
  "$(api_status "$TOKEN_B" POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_A_ID" --argjson p "$(mkseed bxa)" '{projectId:$pid, prospects:[$p]}')")" "404"
assert_eq "no project_prospects row under A from B's attempt" \
  "$(psql_local "SELECT count(*)::int FROM project_prospects WHERE project_id='$PROJECT_A_ID' AND tenant_id='$TENANT_B';")" "0"

step "POOLED RESET: sequential A then B on the same worker each see only their own tenant"
assert_eq "A still sees A's project" \
  "$(api "$TOKEN_A" GET /api/projects | jq --arg id "$PROJECT_A_ID" 'any(.projects[]?; .id==$id)')" "true"
assert_eq "B still does NOT see A's project (no app.tenant_id bleed)" \
  "$(api "$TOKEN_B" GET /api/projects | jq --arg id "$PROJECT_A_ID" 'any(.projects[]?; .id==$id)')" "false"

step "DB-level WITH CHECK backstop: INSERT with a foreign tenant_id is rejected by RLS"
RLS_OUT="$(psql_local "BEGIN; SET LOCAL ROLE app_rls; SELECT set_config('app.tenant_id','$TENANT_A',true);
  INSERT INTO projects(id,tenant_id,name,created_at,updated_at) VALUES('$RUN_TAG-x','$TENANT_B','x',now(),now()); ROLLBACK;" 2>&1 || true)"
assert_eq "app_rls(A) INSERT tenant_id=B → row-level security violation" \
  "$(echo "$RLS_OUT" | grep -qi 'row-level security' && echo violated || echo "NOT-violated: $RLS_OUT")" "violated"

step "account-deletion blast radius (self-host edition): deleting B leaves A intact"
# Deletion now requires the mandatory survey body (else 400).
assert_eq "DELETE /api/me/account as B → 200" \
  "$(api_status "$TOKEN_B" DELETE /api/me/account '{"reason":"no_longer_needed"}')" "200"
assert_eq "tenant B removed" "$(psql_local "SELECT count(*)::int FROM tenants WHERE id='$TENANT_B';")" "0"
assert_eq "project B removed (cascade)" "$(psql_local "SELECT count(*)::int FROM projects WHERE id='$PROJECT_B_ID';")" "0"
assert_eq "tenant A UNTOUCHED" "$(psql_local "SELECT count(*)::int FROM tenants WHERE id='$TENANT_A';")" "1"
assert_eq "project A UNTOUCHED" "$(psql_local "SELECT count(*)::int FROM projects WHERE id='$PROJECT_A_ID';")" "1"
assert_eq "prospect A UNTOUCHED" "$(psql_local "SELECT count(*)::int FROM prospects WHERE id=$PROSPECT_A_ID;")" "1"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
