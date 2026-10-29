#!/usr/bin/env bash
# Cloud-edition regression against Stripe TEST MODE: what the billing code
# writes once Stripe answers — Checkout, the webhook mirror, plan changes and
# auto top-up. regression-cloud-stripe-webhook.sh stops where a real Stripe
# answer is needed; this suite starts there.
#
# Webhooks ignore the event payload and read Stripe back, so each case makes
# real test-mode objects through the Stripe API, then posts a locally signed
# event that only names the customer (no `stripe listen`).
#
# Prerequisites:
#   - STRIPE_SECRET_KEY in the environment: a Stripe TEST-mode secret key
#     (sk_test_…) of the account whose prices carry metadata.plan. Unset (or
#     the e2e dummy) skips the suite; any other key is refused. The key is
#     never printed.
#   - The cloud worker started with the same key, in its own terminal:
#       STRIPE_SECRET_KEY=sk_test_… ./e2e/cloud-edition-up.sh
#     One way to take the key from backend/.dev.vars without printing it:
#       export STRIPE_SECRET_KEY="$(grep '^STRIPE_SECRET_KEY=' backend/.dev.vars | cut -d= -f2- | tr -d '"')"
#
# Usage:
#   ./e2e/regression-cloud-stripe-testmode.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-stripe-testmode.sh   # keep the tenant (Stripe objects are still removed)
#
# Leaves nothing in Stripe: the customer it made is deleted (its subscriptions
# go with it) and the throwaway price is archived.
#
# Exit status: 0 all pass or skipped / 1 setup failed or refused / 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-stripe-testmode-$TS@example.com"
WHSEC="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_test_secret}"
source "$REPO_ROOT/e2e/lib-cloud.sh"

KEY="${STRIPE_SECRET_KEY:-}"
case "$KEY" in
  "" | sk_test_e2e_dummy)
    echo "SKIP regression-cloud-stripe-testmode: set STRIPE_SECRET_KEY to a Stripe test-mode key (see the header)." >&2
    exit 0 ;;
  sk_test_*) ;;
  *)
    echo "Refusing: STRIPE_SECRET_KEY is not a Stripe test-mode secret key (sk_test_…)." >&2
    exit 1 ;;
esac

require_jq
API_OUT="$(mktemp)"
CUS=""
DRIFT_PRICE=""
DRIFT_PRODUCT=""

st() { # st METHOD PATH [form fields...] — Stripe API with the test key
  local m="$1" p="$2"; shift 2
  local args=(); for a in "$@"; do args+=(--data-urlencode "$a"); done
  if [[ "$m" == GET ]]; then
    curl -sS -G -u "$KEY:" -H 'Stripe-Version: 2026-03-25.dahlia' "https://api.stripe.com/v1$p" "${args[@]}"
  else
    curl -sS -X "$m" -u "$KEY:" -H 'Stripe-Version: 2026-03-25.dahlia' "https://api.stripe.com/v1$p" "${args[@]}"
  fi
}

cleanup() {
  local rc=$?
  if [[ -n "$CUS" ]]; then
    for s in $(st GET /checkout/sessions "customer=$CUS" "status=open" "limit=100" | jq -r '.data[]?.id'); do
      st POST "/checkout/sessions/$s/expire" > /dev/null
    done
    st DELETE "/customers/$CUS" > /dev/null
  fi
  [[ -n "$DRIFT_PRICE" ]] && st POST "/prices/$DRIFT_PRICE" "active=false" > /dev/null
  [[ -n "$DRIFT_PRODUCT" ]] && st POST "/products/$DRIFT_PRODUCT" "active=false" > /dev/null
  (exit "$rc")
  cloud_teardown
}
trap cleanup EXIT

T=""
row() { psql_local "SELECT plan || '|' || COALESCE(stripe_subscription_id, '-') FROM tenant_plans WHERE tenant_id='$T';"; }
col() { psql_local "SELECT $1 FROM tenant_plans WHERE tenant_id='$T';"; }
send() { # send BODY → HTTP status of the signed webhook post
  local sig; sig="$("$REPO_ROOT/e2e/sign-stripe-event.sh" "$WHSEC" "$1")"
  curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/stripe/webhook" -H "stripe-signature: $sig" --data "$1"
}
sub_event() { jq -nc --arg t "customer.subscription.$1" --arg id "$2" --arg cus "$CUS" '{type:$t, data:{object:{id:$id, customer:$cus}}}'; }
completed_event() { jq -nc --arg u "$THROW_USER_ID" --arg cus "$CUS" --arg sub "$1" \
  '{type:"checkout.session.completed", data:{object:{mode:"subscription", client_reference_id:$u, customer:$cus, subscription:$sub}}}'; }
new_sub() { # new_sub PRICE [fields...] → subscription id
  local price="$1"; shift
  st POST /subscriptions "customer=$CUS" "items[0][price]=$price" "$@" | jq -r '.id // ""'
}
sub_status() { st GET "/subscriptions/$1" | jq -r .status; }
cancel_sub() { st DELETE "/subscriptions/$1" > /dev/null; }
checkout() { api_status POST /api/me/checkout "$(jq -nc --arg p "$1" \
  '{priceId:$p, successUrl:"http://localhost:5273/plans?checkout=success", cancelUrl:"http://localhost:5273/plans?checkout=cancel"}')"; }
open_sessions() { st GET /checkout/sessions "customer=$CUS" "status=open" "limit=100" | jq -c '[.data[] | {id, customer}]'; }
change() { # change PRICE FROM_PLAN [PERIOD_END] → HTTP status, body in $API_OUT
  local pe="${3:-$(api GET /api/me/subscription | jq -r .periodEnd)}"
  api_status POST /api/me/plan-change "$(jq -nc --arg p "$1" --arg f "$2" --arg e "$pe" '{priceId:$p, fromPlan:$f, periodEnd:$e}')"
}
item_of() { st GET "/subscriptions/$1" | jq -r ".items.data[0].$2"; }
paid_invoices() { st GET /invoices "subscription=$1" "status=paid" "limit=50" | jq -r '.data | length'; }
set_card() { st POST "/customers/$CUS" "invoice_settings[default_payment_method]=$1" > /dev/null; }
wait_for() { # wait_for SECONDS EXPECTED CMD... — poll until CMD prints EXPECTED; prints the last output
  local secs="$1" want="$2"; shift 2
  local got=""
  for _ in $(seq 1 "$secs"); do got="$("$@")"; [[ "$got" == "$want" ]] && break; sleep 1; done
  echo "$got"
}
topup_invoice() { # topup_invoice [finalize|pay] → invoice id stamped like an auto top-up
  local id; id="$(st POST /invoices "customer=$CUS" "auto_advance=false" "collection_method=charge_automatically" \
    "pending_invoice_items_behavior=exclude" "metadata[leadace_tenant_id]=$T" "metadata[leadace_credit_cents]=2500" | jq -r .id)"
  if [[ -n "${1:-}" ]]; then
    st POST /invoiceitems "customer=$CUS" "invoice=$id" "amount=2500" "currency=usd" > /dev/null
    st POST "/invoices/$id/finalize" > /dev/null
    [[ "$1" == pay ]] && st POST "/invoices/$id/pay" > /dev/null
  fi
  echo "$id"
}
invoice_status() { st GET "/invoices/$1" | jq -r '.status // .error.code'; }
record_outreach() { # record_outreach PROSPECT_ID → HTTP status (each record kicks an auto top-up)
  api_status POST /api/outreach "$(jq -nc --arg pid "$PROJ" --argjson prid "$1" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"s", body:"b", status:"sent"}')"
}

cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"
START="$(date +%s)"

step "setup: plan prices, a throwaway price, the worker's key"
PRICES="$(st GET /prices "active=true" "type=recurring" "limit=100")"
price_for() { echo "$PRICES" | jq -r --arg p "$1" '[.data[] | select(.metadata.plan == $p)][0].id // ""'; }
STARTER="$(price_for starter)"; PRO="$(price_for pro)"; SCALE="$(price_for scale)"
[[ -n "$STARTER" && -n "$PRO" && -n "$SCALE" ]] || { echo "the test-mode account has no active plan prices (metadata.plan)" >&2; exit 1; }
DRIFT="$(st POST /prices "unit_amount=100" "currency=usd" "recurring[interval]=month" "product_data[name]=LeadAce e2e drift $TS")"
DRIFT_PRICE="$(echo "$DRIFT" | jq -r '.id // ""')"; DRIFT_PRODUCT="$(echo "$DRIFT" | jq -r '.product // ""')"
[[ -n "$DRIFT_PRICE" ]] || { echo "could not create the throwaway price" >&2; exit 1; }
say "plan prices found; throwaway price created"

step "A. Checkout"
CODE="$(checkout "price_e2e_missing_$TS")"
if [[ "$(api_body | jq -r '.error // ""')" == "Failed to load the price" ]]; then
  echo "The worker cannot read Stripe with its key. Start it with the same test key: STRIPE_SECRET_KEY=sk_test_… ./e2e/cloud-edition-up.sh" >&2
  exit 1
fi
assert_eq "unknown price → 400" "$CODE" "400"
assert_eq "price without plan metadata → 400" "$(checkout "$DRIFT_PRICE")" "400"
assert_eq "first Checkout → 200" "$(checkout "$STARTER")" "200"
CUS="$(col "COALESCE(stripe_customer_id, '')")"
assert_eq "  the tenant now has a stored Stripe customer" "$([[ "$CUS" == cus_* ]] && echo yes || echo "no ($CUS)")" "yes"
S1="$(open_sessions)"
assert_eq "  one open session, on that customer" "$(echo "$S1" | jq -r --arg c "$CUS" 'length == 1 and .[0].customer == $c')" "true"
assert_eq "second Checkout → 200" "$(checkout "$STARTER")" "200"
S2="$(open_sessions)"
assert_eq "  still one open session, a new one" "$(echo "$S2" | jq -r --arg old "$(echo "$S1" | jq -r '.[0].id')" 'length == 1 and .[0].id != $old')" "true"
assert_eq "  the first session is expired" "$(st GET "/checkout/sessions/$(echo "$S1" | jq -r '.[0].id')" | jq -r .status)" "expired"
# Checkout saves the billing address onto the customer; Stripe Tax needs it on the invoices below.
st POST "/customers/$CUS" "address[line1]=1 Market St" "address[city]=San Francisco" "address[state]=CA" "address[postal_code]=94105" "address[country]=US" > /dev/null
VISA="$(st POST /payment_methods/pm_card_visa/attach "customer=$CUS" | jq -r .id)"
DECLINE="$(st POST /payment_methods/pm_card_chargeCustomerFail/attach "customer=$CUS" | jq -r .id)"
set_card "$VISA"
LIVE="$(new_sub "$STARTER")"
assert_eq "a live subscription on the customer → Checkout 409" "$(checkout "$STARTER")" "409"
cancel_sub "$LIVE"
INCOMPLETE="$(new_sub "$STARTER" "payment_behavior=default_incomplete")"
assert_eq "  (fixture) the second subscription is incomplete" "$(sub_status "$INCOMPLETE")" "incomplete"
assert_eq "an incomplete subscription → Checkout 409" "$(checkout "$STARTER")" "409"
cancel_sub "$INCOMPLETE"
assert_eq "after both are canceled → Checkout 200" "$(checkout "$STARTER")" "200"
psql_local "UPDATE tenant_plans SET stripe_customer_id = 'cus_e2e_missing_$TS' WHERE tenant_id='$T';" > /dev/null
assert_eq "a stored customer Stripe does not have → Checkout 502" "$(checkout "$STARTER")" "502"
psql_local "UPDATE tenant_plans SET stripe_customer_id = '$CUS' WHERE tenant_id='$T';" > /dev/null
for s in $(st GET /checkout/sessions "customer=$CUS" "status=open" "limit=100" | jq -r '.data[].id'); do st POST "/checkout/sessions/$s/expire" > /dev/null; done

step "B. the webhook mirrors the customer's live subscription"
A="$(new_sub "$PRO")"
assert_eq "active Pro: event → 200" "$(send "$(sub_event updated "$A")")" "200"
assert_eq "  plan and subscription are Stripe's" "$(row)" "pro|$A"
assert_eq "  period is Stripe's" "$(col "extract(epoch from current_period_start)::bigint || '-' || extract(epoch from current_period_end)::bigint")" \
  "$(item_of "$A" current_period_start)-$(item_of "$A" current_period_end)"
psql_local "UPDATE tenant_plans SET auto_top_up_enabled = true WHERE tenant_id='$T';" > /dev/null
cancel_sub "$A"
assert_eq "canceled: deleted event → 200" "$(send "$(sub_event deleted "$A")")" "200"
assert_eq "  free with no subscription held" "$(row)" "free|-"
assert_eq "  auto top-up switched off" "$(col auto_top_up_enabled)" "f"
psql_local "UPDATE tenant_plans SET auto_top_up_enabled = true WHERE tenant_id='$T';" > /dev/null
B="$(new_sub "$PRO" "default_payment_method=$DECLINE" "payment_behavior=allow_incomplete")"
assert_eq "  (fixture) a first payment declined leaves it incomplete" "$(sub_status "$B")" "incomplete"
assert_eq "incomplete: event → 200" "$(send "$(sub_event updated "$B")")" "200"
assert_eq "  free with the subscription held" "$(row)" "free|$B"
assert_eq "  attention shows subscription_unpaid" \
  "$(api GET /api/me/attention | jq -c '[.items[].kind | select(. == "subscription_unpaid")]')" '["subscription_unpaid"]'
assert_eq "  billing portal offered" "$(api GET /api/me/plan | jq -r .billingPortal)" "true"
assert_eq "  auto top-up setting unchanged" "$(col auto_top_up_enabled)" "t"
cancel_sub "$B"
C="$(new_sub "$STARTER")"; sleep 1; D="$(new_sub "$PRO")"
assert_eq "two live (Starter, then Pro): event → 200" "$(send "$(sub_event updated "$C")")" "200"
assert_eq "  the newer active one is held" "$(row)" "pro|$D"
cancel_sub "$D"
sleep 1; E="$(new_sub "$PRO" "default_payment_method=$DECLINE" "payment_behavior=allow_incomplete")"
assert_eq "an active one and a newer incomplete one: event → 200" "$(send "$(sub_event updated "$E")")" "200"
assert_eq "  the active one is held" "$(row)" "starter|$C"
cancel_sub "$C"; cancel_sub "$E"
F="$(new_sub "$STARTER")"
assert_eq "a late event naming the canceled A while F is live → 200" "$(send "$(sub_event deleted "$A")")" "200"
assert_eq "  F is held" "$(row)" "starter|$F"
psql_local "UPDATE tenant_plans SET stripe_customer_id = NULL, stripe_subscription_id = NULL, plan = 'free' WHERE tenant_id='$T';" > /dev/null
assert_eq "checkout.session.completed for a tenant with no customer → 200" "$(send "$(completed_event "$F")")" "200"
assert_eq "  the customer is linked" "$(col "COALESCE(stripe_customer_id, '-')")" "$CUS"
assert_eq "  and its subscription mirrored" "$(row)" "starter|$F"
sleep 1; G="$(new_sub "$DRIFT_PRICE")"
assert_eq "an active subscription on a price without plan metadata: event → 500" "$(send "$(sub_event updated "$G")")" "500"
assert_eq "  row untouched" "$(row)" "starter|$F"
cancel_sub "$G"
cancel_sub "$F"
( psql_local "SELECT pg_advisory_lock(hashtext('$T:subscription')), pg_sleep(22);" > /dev/null ) &
LOCKER=$!
sleep 2
assert_eq "the tenant's subscription lock held elsewhere: event → 500 after lock_timeout" "$(send "$(sub_event deleted "$F")")" "500"
assert_eq "  row untouched" "$(row)" "starter|$F"
wait "$LOCKER"
assert_eq "lock released: the redelivery → 200" "$(send "$(sub_event deleted "$F")")" "200"
assert_eq "  it writes" "$(row)" "free|-"

step "C. plan changes"
H="$(new_sub "$STARTER")"
send "$(sub_event updated "$H")" > /dev/null
assert_eq "  (fixture) Starter mirrored" "$(row)" "starter|$H"
BEFORE_START="$(item_of "$H" current_period_start)"
sleep 2
T0="$(date +%s)"
assert_eq "upgrade Starter → Pro → 200" "$(change "$PRO" starter)" "200"
NEW_START="$(item_of "$H" current_period_start)"
assert_eq "  Stripe: Pro, a period that starts now" \
  "$(item_of "$H" price.id)|$([[ "$NEW_START" -ge $((T0 - 5)) && "$NEW_START" != "$BEFORE_START" ]] && echo now || echo "no ($BEFORE_START → $NEW_START)")" "$PRO|now"
send "$(sub_event updated "$H")" > /dev/null
assert_eq "  after the event: Pro with the new period start" \
  "$(col "plan || '|' || extract(epoch from current_period_start)::bigint")" "pro|$NEW_START"
set_card "$DECLINE"
PAID="$(paid_invoices "$H")"; END_BEFORE="$(item_of "$H" current_period_end)"
assert_eq "upgrade Pro → Scale with a card that declines → 502" "$(change "$SCALE" pro)" "502"
assert_eq "  Stripe unchanged: Pro, same period" "$(item_of "$H" price.id)|$(item_of "$H" current_period_end)" "$PRO|$END_BEFORE"
assert_eq "  no new paid invoice" "$(paid_invoices "$H")" "$PAID"
set_card "$VISA"
assert_eq "downgrade Pro → Starter → 200" "$(change "$STARTER" pro)" "200"
SCHED="$(st GET "/subscriptions/$H" "expand[]=schedule")"
assert_eq "  a schedule whose last phase is Starter from the period end" \
  "$(echo "$SCHED" | jq -r '[.schedule.phases[-1].items[0].price, .schedule.phases[-1].start_date == .items.data[0].current_period_end] | map(tostring) | join("|")')" "$STARTER|true"
SCHED_ID="$(echo "$SCHED" | jq -r .schedule.id)"
assert_eq "upgrade while the switch is scheduled → 409" "$(change "$SCALE" pro)" "409"
assert_eq "  says to keep Pro first" "$(api_body | jq -r '.detail' | grep -c 'Your switch to Starter on .* is scheduled. To upgrade, keep Pro')" "1"
assert_eq "  Stripe unchanged: Pro, the same schedule" "$(item_of "$H" price.id)|$(st GET "/subscriptions/$H" | jq -r .schedule)" "$PRO|$SCHED_ID"
assert_eq "keep Pro (drop the switch) → 200" "$(api_status DELETE /api/me/plan-change)" "200"
assert_eq "  no schedule" "$(st GET "/subscriptions/$H" | jq -r '.schedule // "none"')" "none"
HALF="$(st POST /subscription_schedules "from_subscription=$H" | jq -r .id)"
assert_eq "  (fixture) a half-made one-phase schedule" "$(st GET "/subscription_schedules/$HALF" | jq -r '.phases | length')" "1"
assert_eq "then upgrade Pro → Scale → 200" "$(change "$SCALE" pro)" "200"
assert_eq "  the half-made schedule was released and the upgrade applied" \
  "$(st GET "/subscription_schedules/$HALF" | jq -r .status)|$(item_of "$H" price.id)|$(st GET "/subscriptions/$H" | jq -r '.schedule // "none"')" "released|$SCALE|none"
assert_eq "a stale fromPlan → 409" "$(change "$PRO" pro)" "409"
assert_eq "a stale periodEnd → 409" "$(change "$PRO" scale "2020-01-01T00:00:00.000Z")" "409"
assert_eq "the same plan → 409" "$(change "$SCALE" scale)" "409"
send "$(sub_event updated "$H")" > /dev/null
assert_eq "  (fixture) Scale mirrored" "$(row)" "scale|$H"

step "D. auto top-up"
api PUT /api/tenant-settings '{"legalName":"E2E Co","physicalAddress":"1 E2E St, Test City","defaultSenderCountry":"US"}' > /dev/null
PROJ="$(api POST /api/projects '{"name":"stripe testmode"}' | jq -r '.id')"
api PUT "/api/projects/$PROJ/settings" '{"outboundMode":"send"}' > /dev/null
register() { # register FROM TO → ids of prospects FROM..TO-1 (a batch takes at most 100)
  api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJ" --arg ts "$TS" --argjson from "$1" --argjson to "$2" \
    '{projectId:$pid, prospects: [range($from;$to) | {
        organizationDomain: ("e2e-stm-\($ts)-\(.).example"), organizationName: "STM Org",
        organizationWebsiteUrl: ("https://e2e-stm-\($ts)-\(.).example"), country: "US", countrySource: "manual",
        name: ("STM-\(.)"), overview: "seed", websiteUrl: ("https://e2e-stm-\($ts)-\(.).example/a"),
        email: ("stm-\(.)@e2e-stm-\($ts).example"), matchReason: "seed" }]}')" | jq -r '.insertedIds[]?'
}
P=($(register 0 100) $(register 100 106))
assert_eq "  (fixture) 106 prospects registered" "${#P[@]}" "106"
# Starter's 100 contacted prospects used up, so the next first touch debits credits.
psql_local "UPDATE tenant_plans SET plan = 'starter' WHERE tenant_id='$T';
  INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
  SELECT '$T', '$PROJ', id, 'email', 'seed', 'sent', NOW() FROM prospects
  WHERE tenant_id='$T' AND id NOT IN ($(IFS=,; echo "${P[*]:100:6}"));
  INSERT INTO credit_ledger (tenant_id, kind, amount_cents, reference) VALUES ('$T', 'purchase', 520, 'cs_e2e_stm_$TS');
  UPDATE tenant_plans SET auto_top_up_enabled = true, auto_top_up_threshold_cents = 500, auto_top_up_amount_cents = 2500,
    auto_top_up_invoice_id = NULL, auto_top_up_failed_at = NULL WHERE tenant_id='$T';" > /dev/null
ledger_topups() { psql_local "SELECT COALESCE(string_agg(amount_cents::text || ':' || reference, ',' ORDER BY id), '') FROM credit_ledger WHERE tenant_id='$T' AND kind='auto_top_up';"; }
topup_count() { psql_local "SELECT count(*)::int FROM credit_ledger WHERE tenant_id='$T' AND kind='auto_top_up';"; }
assert_eq "a first touch past the allowance → 201" "$(record_outreach "${P[100]}")" "201"
assert_eq "  \$0.40 debited from the \$5.20 balance, under the \$5.00 threshold" \
  "$(psql_local "SELECT string_agg(amount_cents::text, ',') FROM credit_ledger WHERE tenant_id='$T' AND kind='usage_contacted';")" "-40"
assert_eq "  a top-up is paid and credited +2500" "$(wait_for 30 1 topup_count)" "1"
TOPUP_INV="$(ledger_topups | cut -d: -f2)"
assert_eq "  its invoice is paid in Stripe, slot cleared" "$(invoice_status "$TOPUP_INV")|$(col "COALESCE(auto_top_up_invoice_id, '-')")" "paid|-"
set_card "$DECLINE"
psql_local "UPDATE tenant_plans SET auto_top_up_threshold_cents = 10000 WHERE tenant_id='$T';" > /dev/null
assert_eq "a debit with a card that declines → 201" "$(record_outreach "${P[101]}")" "201"
decline_state() { col "auto_top_up_enabled || '|' || CASE WHEN auto_top_up_failed_at IS NULL THEN 'none' ELSE 'stamped' END || '|' || COALESCE(auto_top_up_invoice_id, '-')"; }
assert_eq "  auto top-up switched off with the decline stamped, slot cleared" "$(wait_for 30 "false|stamped|-" decline_state)" "false|stamped|-"
assert_eq "  nothing credited" "$(topup_count)" "1"
set_card "$VISA"
DRAFT="$(topup_invoice)"
psql_local "UPDATE tenant_plans SET auto_top_up_enabled = true, auto_top_up_failed_at = NULL, auto_top_up_invoice_id = '$DRAFT' WHERE tenant_id='$T';" > /dev/null
assert_eq "a fresh draft in the slot, still wanted: a kick → 201" "$(record_outreach "${P[102]}")" "201"
sleep 6
assert_eq "  the draft is left to its run" "$(invoice_status "$DRAFT")|$(col auto_top_up_invoice_id)" "draft|$DRAFT"
assert_eq "auto top-up switched off → 200" "$(api_status PUT /api/me/credits/auto-top-up '{"enabled":false}')" "200"
assert_eq "  the draft is deleted, slot cleared" "$(invoice_status "$DRAFT")|$(col "COALESCE(auto_top_up_invoice_id, '-')")" "resource_missing|-"
OPEN="$(topup_invoice finalize)"
psql_local "UPDATE tenant_plans SET auto_top_up_invoice_id = '$OPEN' WHERE tenant_id='$T';" > /dev/null
assert_eq "an open invoice no longer wanted: a kick → 201" "$(record_outreach "${P[103]}")" "201"
open_state() { echo "$(invoice_status "$OPEN")|$(col "COALESCE(auto_top_up_invoice_id, '-')")"; }
assert_eq "  voided, slot cleared" "$(wait_for 20 "void|-" open_state)" "void|-"
psql_local "UPDATE tenant_plans SET auto_top_up_invoice_id = 'in_e2e_missing_$TS' WHERE tenant_id='$T';" > /dev/null
assert_eq "an invoice id Stripe does not have: a kick → 201" "$(record_outreach "${P[104]}")" "201"
slot() { col "COALESCE(auto_top_up_invoice_id, '-')"; }
assert_eq "  slot cleared" "$(wait_for 20 - slot)" "-"
PAIDINV="$(topup_invoice pay)"
assert_eq "  (fixture) a paid top-up invoice" "$(invoice_status "$PAIDINV")" "paid"
psql_local "UPDATE tenant_plans SET auto_top_up_invoice_id = '$PAIDINV' WHERE tenant_id='$T';" > /dev/null
assert_eq "a paid invoice in the slot: a kick → 201" "$(record_outreach "${P[105]}")" "201"
paid_state() { psql_local "SELECT count(*)::int || '|' || (SELECT COALESCE(auto_top_up_invoice_id, '-') FROM tenant_plans WHERE tenant_id='$T') FROM credit_ledger WHERE tenant_id='$T' AND reference='$PAIDINV';"; }
assert_eq "  credited, slot cleared" "$(wait_for 20 "1|-" paid_state)" "1|-"
PAID_EVENT="$(jq -nc --arg id "$PAIDINV" --arg t "$T" '{type:"invoice.paid", data:{object:{id:$id, metadata:{leadace_tenant_id:$t, leadace_credit_cents:"2500"}}}}')"
assert_eq "  invoice.paid for it → 200" "$(send "$PAID_EVENT")" "200"
assert_eq "  credited once" "$(psql_local "SELECT count(*)::int FROM credit_ledger WHERE tenant_id='$T' AND reference='$PAIDINV';")" "1"
OPEN2="$(topup_invoice finalize)"
psql_local "UPDATE tenant_plans SET plan = 'scale', auto_top_up_enabled = true, auto_top_up_invoice_id = '$OPEN2' WHERE tenant_id='$T';" > /dev/null
cancel_sub "$H"
assert_eq "the subscription ends with a top-up invoice open: deleted event → 200" "$(send "$(sub_event deleted "$H")")" "200"
assert_eq "  free, the invoice voided, slot cleared" "$(row)|$(invoice_status "$OPEN2")|$(col "COALESCE(auto_top_up_invoice_id, '-')")" "free|-|void|-"

say "runtime $(( $(date +%s) - START ))s"
cloud_summary
