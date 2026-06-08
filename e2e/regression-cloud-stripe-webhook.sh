#!/usr/bin/env bash
# Cloud-edition regression: Stripe webhook signature + tenant_plans mutations
# (coverage-audit §2 gap #12 — routes/stripe-webhook.ts + services/stripe-webhook.ts).
#
# verifyStripeSignature is unit-tested; this drives the live route on a
# LEADACE_EDITION=cloud worker (self-hosted 404s the webhook). Fixtured,
# HMAC-signed events via e2e/sign-stripe-event.sh — no real Stripe account.
#
# COVERED (no network — these handlers read the event payload only and match
# the tenant by stripe_subscription_id):
#   - signature verification: missing header → 400, bad sig → 401, stale ts → 401,
#     valid sig for an unknown subscription → 200 (logged, no-op)
#   - customer.subscription.updated: active+plan metadata grants the tier;
#     period dates mirrored; active+missing metadata leaves the row untouched
#     (config-drift guard); idempotent on re-delivery
#   - customer.subscription.deleted: downgrades to free
#   - unlimited-tier protection: updated/deleted both refuse to overwrite 'unlimited'
#
# OUT OF SCOPE (require the real Stripe API, like the real-Gmail leg of
# regression-outbound.sh): checkout.session.completed and the cancel+refund
# path BOTH issue an unconditional fetch to https://api.stripe.com (not
# env-overridable). Those need Stripe test mode and are not exercised here.
#
# The cloud worker's STRIPE_WEBHOOK_SECRET must match WHSEC below (both default
# to whsec_e2e_test_secret — see e2e/cloud-edition-up.sh).
#
# Usage:
#   ./e2e/regression-cloud-stripe-webhook.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-stripe-webhook.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-stripe-$TS@example.com"
WHSEC="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_test_secret}"
SUB="sub_e2e_$TS"
source "$REPO_ROOT/e2e/lib-cloud.sh"

trap cloud_teardown EXIT

require_jq
API_OUT="$(mktemp)"
cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"

NOW="$(date +%s)"
PEND="$((NOW + 2592000))"

plan_of() { psql_local "SELECT plan FROM tenant_plans WHERE tenant_id='$T';"; }

# POST a signed event. $1=body, $2=optional flag (--stale|--bad-sig). Public
# route (no bearer) — dedicated curl, not the api_status helper.
post_event() {
  local body="$1" flag="${2:-}" sig
  if [[ -n "$flag" ]]; then
    sig="$("$REPO_ROOT/e2e/sign-stripe-event.sh" "$flag" "$WHSEC" "$body")"
  else
    sig="$("$REPO_ROOT/e2e/sign-stripe-event.sh" "$WHSEC" "$body")"
  fi
  curl -sS -o "$API_OUT" -w '%{http_code}' -X POST "$API_URL/api/stripe/webhook" \
    -H "stripe-signature: $sig" --data "$body"
}

sub_updated()        { jq -nc --arg id "$SUB" --arg plan "$1" --arg st "$2" --argjson ps "$NOW" --argjson pe "$PEND" \
  '{type:"customer.subscription.updated", data:{object:{id:$id, status:$st, current_period_start:$ps, current_period_end:$pe, items:{data:[{price:{metadata:{plan:$plan}}}]}}}}'; }
sub_updated_nometa() { jq -nc --arg id "$SUB" --arg st "$1" --argjson ps "$NOW" --argjson pe "$PEND" \
  '{type:"customer.subscription.updated", data:{object:{id:$id, status:$st, current_period_start:$ps, current_period_end:$pe, items:{data:[{price:{metadata:{}}}]}}}}'; }
sub_deleted()        { jq -nc --arg id "$SUB" '{type:"customer.subscription.deleted", data:{object:{id:$id}}}'; }

step "A. signature verification (no DB state required)"
CODE="$(curl -sS -o "$API_OUT" -w '%{http_code}' -X POST "$API_URL/api/stripe/webhook" --data "$(sub_deleted)")"
assert_eq "missing stripe-signature header → 400" "$CODE" "400"
assert_eq "  body names the missing header" "$(api_body | jq -r '.error // ""')" "Missing stripe-signature header"

assert_eq "bad signature → 401" "$(post_event "$(sub_deleted)" --bad-sig)" "401"
assert_eq "  body = Invalid signature" "$(api_body | jq -r '.error // ""')" "Invalid signature"

assert_eq "stale timestamp (outside 300s tolerance) → 401" "$(post_event "$(sub_deleted)" --stale)" "401"

# Valid signature, but no tenant_plans row references this subscription yet
# (handleSubscriptionUpdated matches by stripe_subscription_id, finds none →
# logs "no tenant found" and returns). The tenant's provisioning-default plan
# must be left untouched — the handler only SELECTs/UPDATEs, never INSERTs.
PLAN_BEFORE="$(plan_of)"
assert_eq "valid sig, unknown subscription → 200 (logged no-op)" "$(post_event "$(sub_updated pro active)")" "200"
assert_eq "  unknown-subscription event did not change the tenant plan" "$(plan_of)" "$PLAN_BEFORE"

step "B. subscription.updated grants the tier (active + plan metadata)"
cloud_seed_plan "$T" starter "$SUB"
assert_eq "seeded starter row with stripe_subscription_id" "$(plan_of)" "starter"
assert_eq "updated(active, plan=pro) → 200" "$(post_event "$(sub_updated pro active)")" "200"
assert_eq "  tenant promoted to pro" "$(plan_of)" "pro"
assert_eq "  current_period_start mirrored from the event (recent)" \
  "$(psql_local "SELECT (current_period_start > NOW() - INTERVAL '10 minutes') FROM tenant_plans WHERE tenant_id='$T';")" "t"

step "C. idempotent re-delivery"
assert_eq "same updated event re-delivered → 200" "$(post_event "$(sub_updated pro active)")" "200"
assert_eq "  plan still pro (UPDATE is idempotent)" "$(plan_of)" "pro"

step "D. config-drift guard: active subscription, missing plan metadata → no change"
cloud_seed_plan "$T" starter            # reset tier (keeps stripe_subscription_id)
assert_eq "reset to starter" "$(plan_of)" "starter"
assert_eq "updated(active, NO metadata) → 200" "$(post_event "$(sub_updated_nometa active)")" "200"
assert_eq "  plan left untouched at starter (operator must fix Price metadata)" "$(plan_of)" "starter"

step "E. subscription.deleted downgrades to free"
assert_eq "deleted → 200" "$(post_event "$(sub_deleted)")" "200"
assert_eq "  tenant downgraded to free" "$(plan_of)" "free"

step "F. unlimited-tier protection (webhook never overwrites a manual unlimited)"
cloud_seed_plan "$T" unlimited "$SUB"
assert_eq "seeded unlimited" "$(plan_of)" "unlimited"
assert_eq "updated(active, pro) against unlimited → 200" "$(post_event "$(sub_updated pro active)")" "200"
assert_eq "  still unlimited (update refused)" "$(plan_of)" "unlimited"
assert_eq "deleted against unlimited → 200" "$(post_event "$(sub_deleted)")" "200"
assert_eq "  still unlimited (downgrade refused)" "$(plan_of)" "unlimited"

cloud_summary
