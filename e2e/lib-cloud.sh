# Shared helpers for the cloud-edition E2E regression cluster
# (regression-cloud-*.sh). Sourced, not executed.
#
# These suites target a SECOND API Worker booted with LEADACE_EDITION=cloud
# (default :8789, via e2e/cloud-edition-up.sh). The default dev worker
# (npm run dev:api, :8787) is self-hosted — getTenantPlan short-circuits every
# tenant to 'unlimited' (plan-limits.ts), so the quota / plan-limit / billing
# code paths never fire there. Only against a cloud-edition worker do plan
# caps actually bind.
#
# Determinism: each suite provisions its OWN throwaway tenant (a fresh GoTrue
# user → fresh tenant, every counter starts at 0) via the Admin API, seeds its
# plan + counters, asserts, then deletes the tenant on exit (DELETE FROM
# tenants cascades all its rows). Nothing touches the developer's real tenant.
#
# The sourcing script must set REPO_ROOT before sourcing this file.

set -uo pipefail

API_URL="${API_URL:-http://localhost:8789}"   # cloud-edition worker
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"
TS="${TS:-$(date +%s)}"

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

# Single-tenant bearer: the throwaway-tenant user, set by cloud_provision_tenant.
TOKEN="${TOKEN:-}"
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
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }
dotenv() { grep -E "^$1=" "$REPO_ROOT/backend/.dev.vars" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'; }

# Confirm the target worker is up AND is the cloud edition before seeding.
# Edition probe: self-hosted 404s POST /api/stripe/webhook (requireCloudEdition
# fails first); cloud 400s it (passes the edition + stripe-env guards, then
# rejects the missing signature). Unauthenticated, no side effects.
cloud_preflight() {
  local h; h="$(curl -sS "$API_URL/health" 2>/dev/null || true)"
  [[ "$(echo "$h" | jq -r .ok 2>/dev/null)" == "true" ]] || {
    echo "cloud worker not healthy at $API_URL — start it with ./e2e/cloud-edition-up.sh" >&2; exit 1; }
  local code; code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/stripe/webhook" 2>/dev/null || true)"
  [[ "$code" == "400" ]] || {
    echo "worker at $API_URL is not LEADACE_EDITION=cloud (webhook probe got $code, want 400)." >&2
    echo "Start the cloud worker: ./e2e/cloud-edition-up.sh" >&2; exit 1; }
  say "cloud worker healthy at $API_URL (edition=cloud confirmed)"
}

# GoTrue Admin credentials, resolved once from backend/.dev.vars.
SVC=""
SUPA_URL=""
cloud_init_admin() {
  SVC="$(dotenv SUPABASE_SERVICE_ROLE_KEY)"
  SUPA_URL="$(dotenv SUPABASE_URL)"; SUPA_URL="${SUPA_URL:-http://127.0.0.1:54321}"
  [[ -n "$SVC" ]] || { echo "SUPABASE_SERVICE_ROLE_KEY not found in backend/.dev.vars" >&2; exit 1; }
}

# Provision a throwaway tenant: create a GoTrue user, mint its JWT, make the
# first authenticated hit (auto-provisions tenant + tenant_members), resolve the
# tenant id. Sets globals THROW_USER_ID, TOKEN, THROW_TENANT_ID.
THROW_USER_ID=""
THROW_TENANT_ID=""
cloud_provision_tenant() {
  local email="$1"
  local create
  create="$(curl -sS -X POST "$SUPA_URL/auth/v1/admin/users" \
    -H "Authorization: Bearer $SVC" -H "apikey: $SVC" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg e "$email" --arg p "e2e-pw-$TS" '{email:$e, email_confirm:true, password:$p}')")"
  THROW_USER_ID="$(echo "$create" | jq -r '.id // ""')"
  [[ -n "$THROW_USER_ID" && "$THROW_USER_ID" != "null" ]] || { echo "failed to create throwaway user: $create" >&2; exit 1; }
  TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh" --email "$email")"
  [[ -n "$TOKEN" ]] || { echo "failed to mint JWT for throwaway tenant" >&2; exit 1; }
  api GET /api/projects > /dev/null   # auto-provision tenant + tenant_members
  THROW_TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$THROW_USER_ID' LIMIT 1;")"
  [[ -n "$THROW_TENANT_ID" ]] || { echo "throwaway tenant was not auto-provisioned" >&2; exit 1; }
  say "throwaway tenant=$THROW_TENANT_ID (user=$email)"
}

# Seed/refresh the tenant_plans row. plan ∈ free|starter|pro|scale|unlimited.
# starter/pro get a current_period_start — MANDATORY, else the monthly window
# never fires and quota is effectively unlimited (manual-plan-setup.local.md
# pitfall 1, plan-limits.ts:182). Optional sub_id sets stripe_subscription_id
# so a fixtured customer.subscription.* event can match this row.
cloud_seed_plan() {
  local tenant="$1" plan="$2" sub_id="${3:-}"
  local cols="tenant_id, plan, created_at, updated_at"
  local vals="'$tenant', '$plan', NOW(), NOW()"
  local setp="plan = '$plan', updated_at = NOW()"
  if [[ "$plan" == "starter" || "$plan" == "pro" ]]; then
    cols="$cols, current_period_start, current_period_end"
    vals="$vals, NOW(), NOW() + INTERVAL '1 month'"
    setp="$setp, current_period_start = NOW(), current_period_end = NOW() + INTERVAL '1 month'"
  fi
  if [[ -n "$sub_id" ]]; then
    cols="$cols, stripe_customer_id, stripe_subscription_id"
    vals="$vals, 'cus_e2e_$TS', '$sub_id'"
    setp="$setp, stripe_customer_id = 'cus_e2e_$TS', stripe_subscription_id = '$sub_id'"
  fi
  psql_local "INSERT INTO tenant_plans ($cols) VALUES ($vals)
    ON CONFLICT (tenant_id) DO UPDATE SET $setp;" > /dev/null
}

# Teardown for the trap: drop the throwaway tenant (CASCADE wipes plans /
# projects / prospects / outreach_logs / inquiry_* rows) and its GoTrue user.
# Idempotent and tolerant of partial state.
cloud_teardown() {
  local rc=$?
  rm -f "${API_OUT:-}" 2>/dev/null || true
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2
    echo "SKIP_CLEANUP=1 — leaving throwaway tenant=${THROW_TENANT_ID:-<none>} / user=${THROW_USER_ID:-<none>} in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ -n "${THROW_TENANT_ID:-}" ]]; then
    psql_local "DELETE FROM tenants WHERE id = '$THROW_TENANT_ID';" > /dev/null 2>&1 || true
  fi
  if [[ -n "${THROW_USER_ID:-}" ]]; then
    curl -sS -X DELETE "$SUPA_URL/auth/v1/admin/users/$THROW_USER_ID" -H "Authorization: Bearer $SVC" -H "apikey: $SVC" > /dev/null 2>&1 || true
  fi
  say "removed throwaway tenant + GoTrue user"
  exit "$rc"
}

# Print the PASS/FAIL tally and exit 2 on any failure, 0 otherwise. Call at the
# end of the suite body (BEFORE the trap-driven teardown runs).
cloud_summary() {
  step "summary"
  echo "  PASS=$PASS  FAIL=$FAIL" >&2
  [[ "$FAIL" -gt 0 ]] && exit 2 || exit 0
}
