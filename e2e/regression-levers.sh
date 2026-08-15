#!/usr/bin/env bash
# Curl-based regression for the message-angle lever (Thompson sampling):
#   - run_lever_tick MEASURE (getVariantStats aggregation over the
#     reply-mature window) → DECIDE (P(best) Monte Carlo → floored weights)
#     → PROMOTE + AUDIT, with pBest surfaced on the tick and the decision
#   - idempotency: a second tick the same UTC day reports ran=false and does
#     not re-apply (the (project_id, cycle_date) unique is the claim)
#   - multi-reply clamp: rewardSum above total (v1 gets 2 replies per send)
#     must not break the Beta posterior
#   - archiving a P(best)-dominated variant while keeping ≥2 active
#   - lever_state weights surfaced by get_lever_state; pick draws from them
#   - bodyApproach round-trips through upsert → pick
#   - active cap: an upsert that would exceed maxActiveArms is refused (400)
#   - explicit-variant override + archived-id fall-through on pick
#   - needsReplenishment: true whenever active arms < targetActiveArms (after
#     the tick archives, on the idempotent echo, on the live get_lever_state
#     recompute, and for a single-variant pool); the stagnation-rotation
#     bullet below covers the other cause — an unfulfilled rotation with the
#     pool at targetActiveArms
#   - rewardLookbackDays forgetting window: the tick path narrows getVariantStats
#     to the recent band, while the all-history /stats display stays unwindowed
#   - strategy bandit (PR-B): the tick weighs the active discovery-strategy
#     registry from provenance-attributed stats (unsent arm = uniform-prior
#     optimism), persists lever_state.strategy_weights (surfaced as
#     get_lever_state discovery.weights + needsReplenishment), and journals
#     the discovery decision + configUsed on the day's lever_decisions row
#   - allocation (PR-C): get_lever_state discovery.batchPlan apportions the
#     requested batchSize (default 30) across active strategies by the tick's
#     weights (largest remainder — counts always sum to batchSize; an active
#     strategy the tick hasn't weighed yet enters at the floor share), and the
#     tick journals the prior UTC day's per-strategy registration counts as
#     discovery.registrations (registry-scoped plan-compliance record)
#   - vitals (PR-D): the tick journals the futility check over mature
#     non-bounced email sends (channel-scoped, epoch-cut, NOT lookback-cut);
#     a futile verdict on a project's newest decision surfaces as an
#     outreach_futility item on the tenant-wide /me/attention feed while an
#     ok verdict stays silent
#   - stagnation rotation: after a seeded streak of flat prior decisions
#     (all arms mature, max P(best) < 0.5, same arm set), the tick archives the
#     weakest arm with reason "stagnation" and needsReplenishment stays raised
#     at targetActiveArms until the slot is refilled — either fulfillment leg
#     (pool growth past post-rotation size / a fresh variant row) is pinned
#     with the other leg provably false
#
# The pure decision math (Beta sampling, P(best), floor, archive gate) is unit-
# tested in backend/src/domain/message-bandit.test.ts; this harness covers the
# DB-coupled wiring those tests can't: the SQL aggregate, RLS, the atomic tick,
# and idempotency. Mature sends are backdated via psql (the API always stamps
# sent_at=now, which is never reply-mature).
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Mints its
# own JWT, does all setup/teardown in a throwaway project, and never touches
# tenant-level settings or sending_identities.
#
# Usage:
#   ./e2e/regression-levers.sh
#   SKIP_CLEANUP=1 ./e2e/regression-levers.sh   # leave artifacts
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-levers-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
DOMAIN="$RUN_TAG.example"
EMAIL="contact@$DOMAIN"

PASS=0
FAIL=0

step() { printf '\n=== %s ===\n' "$1" >&2; }
say()  { printf '  %s\n' "$1" >&2; }

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok  %s\n' "$label"
    PASS=$((PASS + 1))
  else
    printf '  FAIL %s\n       want: %s\n       got:  %s\n' "$label" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
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

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

require_jq
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

USER_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_ID' LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || { echo "no tenant for user $USER_ID — sign in once via the frontend first" >&2; exit 1; }
say "tenant_id=$TENANT_ID user_id=$USER_ID"

PROJECT_ID=""
PROJECT_ID2=""
PROJECT_ID3=""
PROJECT_ID4=""
PROJECT_ID5=""
restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2
    echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2
  echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID (cascades variants / outreach / responses / lever_state / lever_decisions)"
  fi
  if [[ -n "${PROJECT_ID2:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID2" > /dev/null || true
    say "deleted forgetting-window project $PROJECT_ID2"
  fi
  if [[ -n "${PROJECT_ID3:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID3" > /dev/null || true
    say "deleted stagnation project $PROJECT_ID3"
  fi
  if [[ -n "${PROJECT_ID4:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID4" > /dev/null || true
    say "deleted epoch project $PROJECT_ID4"
  fi
  if [[ -n "${PROJECT_ID5:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID5" > /dev/null || true
    say "deleted futility project $PROJECT_ID5"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create test project"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

step "seed 3 message variants (v1 with bodyApproach, v2, v3)"
R="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc '{variantId:"v1", subjectPattern:"Hello {{org}} — v1", bodyApproach:"Problem-direct: open with the pain, one-question CTA, under 90 words.", label:"v1"}')")"
assert_eq "variant v1 upserted" "$(echo "$R" | jq -r '.variantId // ""')" "v1"
assert_eq "v1 bodyApproach persisted" "$(echo "$R" | jq -r '.bodyApproach | startswith("Problem-direct")')" "true"
for v in v2 v3; do
  R="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc --arg id "$v" '{variantId:$id, subjectPattern:("Hello {{org}} — "+$id), label:$id}')")"
  assert_eq "variant $v upserted" "$(echo "$R" | jq -r '.variantId // ""')" "$v"
done

step "seed one prospect (FK target for backdated outreach rows)"
IMPORT_BODY="$(jq -nc --arg pid "$PROJECT_ID" --arg d "$DOMAIN" --arg e "$EMAIL" \
  '{projectId:$pid, prospects:[{organizationDomain:$d, organizationName:"Org", organizationWebsiteUrl:("https://"+$d), country:"US", countrySource:"manual", name:"Prospect", overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}]}')"
api POST /api/prospects/batch "$IMPORT_BODY" > /dev/null
PROSPECT_ID="$(psql_local "SELECT id FROM prospects WHERE tenant_id='$TENANT_ID' AND email='$EMAIL' LIMIT 1;")"
[[ -n "$PROSPECT_ID" ]] || { echo "prospect import failed (no row for $EMAIL)" >&2; exit 1; }
say "prospect_id=$PROSPECT_ID"

step "backdate mature sends + replies (v1=36/60, v2=5/60, v3=0/50)"
ins_sends() { # variant, count
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
              SELECT '$TENANT_ID', '$PROJECT_ID', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '30 days', '$1'
              FROM generate_series(1, $2);" > /dev/null
}
ins_replies() { # variant, count
  psql_local "INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at)
              SELECT tenant_id, id, 'email', 'e2e', 'positive', 'reply', now() - interval '29 days'
              FROM outreach_logs WHERE project_id='$PROJECT_ID' AND variant_id='$1' ORDER BY id LIMIT $2;" > /dev/null
}
ins_sends v1 60; ins_replies v1 36
ins_sends v2 60; ins_replies v2 5
ins_sends v3 50
# Multi-reply clamp: give v1's 36 replied sends a SECOND countable reply.
# responses must count distinct replied SENDS (36), not reply rows (72), and
# rewardSum lands at 72 > 60 total — the Beta posterior must clamp it instead
# of going non-positive on the second shape parameter.
ins_replies v1 36
say "inserted 170 sends + 41 replies (+36 duplicate replies on v1 for the distinct-count regression)"

step "backdate channel-affinity data (industry=software_tech, email ~24% vs form 5%)"
# The 170 email sends above (41 replies) live in this prospect's coarse bucket
# once it has an industry; add form sends so the tick can rank email > form.
psql_local "UPDATE prospects SET industry='B2B SaaS' WHERE id=$PROSPECT_ID;" > /dev/null
ins_form_sends() { # count
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
              SELECT '$TENANT_ID', '$PROJECT_ID', $PROSPECT_ID, 'form', 'e2e', 'sent', now() - interval '30 days'
              FROM generate_series(1, $1);" > /dev/null
}
ins_form_replies() { # count
  psql_local "INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at)
              SELECT tenant_id, id, 'form', 'e2e', 'positive', 'reply', now() - interval '29 days'
              FROM outreach_logs WHERE project_id='$PROJECT_ID' AND channel='form' ORDER BY id LIMIT $1;" > /dev/null
}
ins_form_sends 60; ins_form_replies 3
say "inserted 60 form sends + 3 replies"

step "register 2 discovery strategies (s1 attributed via the prospect, s2 unsent)"
R="$(api PUT "/api/projects/$PROJECT_ID/discovery-strategies" "$(jq -nc '{slug:"s1", approach:"e2e: attributed strategy"}')")"
assert_eq "strategy s1 registered active" "$(echo "$R" | jq -r '.slug + ":" + (.archivedAt // "active")')" "s1:active"
R="$(api PUT "/api/projects/$PROJECT_ID/discovery-strategies" "$(jq -nc '{slug:"s2", approach:"e2e: unsent strategy"}')")"
assert_eq "strategy s2 registered active" "$(echo "$R" | jq -r '.slug + ":" + (.archivedAt // "active")')" "s2:active"
# All backdated sends attribute to s1 through the prospect's provenance column;
# s2 enters the bandit at total 0 (the floor keeps it drawable).
psql_local "UPDATE prospects SET discovery_strategy='s1' WHERE id=$PROSPECT_ID;" > /dev/null
# Backdate the project link into yesterday's UTC window so the tick's
# registrations journal (prior-day per-strategy counts) has one row to find.
psql_local "UPDATE project_prospects SET created_at = now() - interval '1 day' WHERE project_id='$PROJECT_ID' AND prospect_id=$PROSPECT_ID;" > /dev/null

step "run_lever_tick #1 (real decision)"
T1="$(api POST "/api/projects/$PROJECT_ID/run-lever-tick")"
assert_eq "tick1 ran"                "$(echo "$T1" | jq -r '.ran')" "true"
assert_eq "tick1 measures v1 sends"  "$(echo "$T1" | jq -r '.samples[] | select(.variantId=="v1") | .total')" "60"
assert_eq "tick1 measures v1 replies" "$(echo "$T1" | jq -r '.samples[] | select(.variantId=="v1") | .responses')" "36"
assert_eq "tick1 archived exactly v3" "$(echo "$T1" | jq -rc '[.archived[].variantId]')" '["v3"]'
# v2 and v3 both sit at P(best) ~0 (candidates), but the ≥2-active floor caps
# archiving to one; the posterior-mean tie-break sheds the weaker v3 (0/50).
assert_eq "tick1 archived entry carries pBest below threshold" "$(echo "$T1" | jq -r '.archived[0].pBest < 0.05')" "true"
assert_eq "tick1 dropped v3 from weights" "$(echo "$T1" | jq -r '.weights | has("v3")')" "false"
assert_eq "tick1 leader v1 outweighs v2" "$(echo "$T1" | jq -r '.weights.v1 > .weights.v2')" "true"
assert_eq "tick1 pBest strongly favors v1 (36/60 vs 5/60)" "$(echo "$T1" | jq -r '.pBest.v1 > 0.9')" "true"
# The floor keeps the dominated survivor drawable: weight = floor/(leader+floor).
assert_eq "tick1 v2 weight held at the floor share" "$(echo "$T1" | jq -r '.weights.v2 > 0.05')" "true"
assert_eq "tick1 channel affinity has software_tech" "$(echo "$T1" | jq -r '.channelAffinity | has("software_tech")')" "true"
assert_eq "tick1 software_tech ranks email first" "$(echo "$T1" | jq -r '.channelAffinity.software_tech[0].channel')" "email"
assert_eq "tick1 software_tech ranks email then form" "$(echo "$T1" | jq -rc '[.channelAffinity.software_tech[].channel]')" '["email","form"]'
# Survivors collapse to {v1, v2} = 2 active < targetActiveArms (3) → /evaluate
# must supply a fresh angle.
assert_eq "tick1 needsReplenishment (2 active < target 3)" "$(echo "$T1" | jq -r '.needsReplenishment')" "true"
# Strategy bandit: registry ∩ stats. s1 carries every non-bounced send (230,
# reward rate ~0.35); unsent s2 sits on the uniform prior (mean 0.5), so
# Thompson optimism favors it until it accumulates sends — same as a fresh
# message variant. Neither is archivable (s2 immature, ≥2-active floor).
assert_eq "tick1 strategy s1 sample total = 230" "$(echo "$T1" | jq -r '.discovery.samples[] | select(.slug=="s1") | .total')" "230"
assert_eq "tick1 unsent s2 gets the uniform-prior optimism" "$(echo "$T1" | jq -r '.discovery.weights.s2 > .discovery.weights.s1')" "true"
assert_eq "tick1 measured s1 keeps a positive weight" "$(echo "$T1" | jq -r '.discovery.weights.s1 > 0.1')" "true"
assert_eq "tick1 no strategy archived" "$(echo "$T1" | jq -rc '[.discovery.archived[].slug]')" '[]'
assert_eq "tick1 needsStrategyReplenishment (2 active < target 3)" "$(echo "$T1" | jq -r '.needsStrategyReplenishment')" "true"
assert_eq "tick1 journals yesterday's registration for s1" "$(echo "$T1" | jq -r '.discovery.registrations.s1')" "1"
# Vitals: 170 mature email sends (the 60 form sends are out of scope), 41
# replied sends (v1's duplicate replies count once), healthy rate → ok.
assert_eq "tick1 vitals counts mature email sends" "$(echo "$T1" | jq -r '.vitals.sends')" "170"
assert_eq "tick1 vitals counts replied sends distinct" "$(echo "$T1" | jq -r '.vitals.replies')" "41"
assert_eq "tick1 vitals verdict ok" "$(echo "$T1" | jq -r '.vitals.verdict')" "ok"

step "run_lever_tick #2 (idempotent — same UTC day)"
T2="$(api POST "/api/projects/$PROJECT_ID/run-lever-tick")"
assert_eq "tick2 ran=false" "$(echo "$T2" | jq -r '.ran')" "false"
assert_eq "tick2 echoes same archived" "$(echo "$T2" | jq -rc '[.archived[].variantId]')" '["v3"]'
# Live recompute from the current active count (2 < 3), not the frozen decision.
assert_eq "tick2 echoes needsReplenishment" "$(echo "$T2" | jq -r '.needsReplenishment')" "true"
assert_eq "tick2 echoes recorded pBest" "$(echo "$T2" | jq -r '.pBest.v1 > 0.9')" "true"
assert_eq "tick2 echoes recorded strategy weights" "$(echo "$T2" | jq -r '.discovery.weights.s2 > .discovery.weights.s1')" "true"
assert_eq "tick2 echoes recorded vitals" "$(echo "$T2" | jq -r '.vitals.verdict')" "ok"

step "get_lever_state"
LS="$(api GET "/api/projects/$PROJECT_ID/lever-state")"
assert_eq "state has weights"        "$(echo "$LS" | jq -r '.weights != null')" "true"
assert_eq "state v1 mature"          "$(echo "$LS" | jq -r '.variants[] | select(.variantId=="v1") | .mature')" "true"
assert_eq "state active excludes archived v3" "$(echo "$LS" | jq -r '[.variants[].variantId] | index("v3") // "absent"')" "absent"
assert_eq "state todaysDecision present" "$(echo "$LS" | jq -r '.todaysDecision != null')" "true"
assert_eq "state todaysDecision records pBest" "$(echo "$LS" | jq -r '.todaysDecision.subject.pBest.v1 > 0.9')" "true"
assert_eq "state channel affinity present" "$(echo "$LS" | jq -r '.channelAffinity | has("software_tech")')" "true"
# Recomputed live from the current active arms (v3 already archived) — /evaluate
# reads this before the tick runs.
assert_eq "state needsReplenishment (live recompute)" "$(echo "$LS" | jq -r '.needsReplenishment')" "true"
# lever_state.strategy_weights surfaced through the discovery block.
assert_eq "state strategy weights persisted" "$(echo "$LS" | jq -r '.discovery.weights.s2 > .discovery.weights.s1')" "true"
assert_eq "state discovery needsReplenishment" "$(echo "$LS" | jq -r '.discovery.needsReplenishment')" "true"
assert_eq "state todaysDecision records configUsed" "$(echo "$LS" | jq -r '.todaysDecision.configUsed.minSamplePerArm')" "30"
# batchPlan: largest-remainder apportionment over the tick's weights — counts
# always sum to the requested batchSize (default 30) across active slugs only.
assert_eq "state batchPlan defaults to a 30-batch plan" "$(echo "$LS" | jq -r '[.discovery.batchPlan[].count] | add')" "30"
LSB="$(api GET "/api/projects/$PROJECT_ID/lever-state?batchSize=10")"
assert_eq "batchPlan counts sum to the requested batchSize" "$(echo "$LSB" | jq -r '[.discovery.batchPlan[].count] | add')" "10"
assert_eq "batchPlan covers exactly the active strategies" "$(echo "$LSB" | jq -rc '[.discovery.batchPlan[].slug] | sort')" '["s1","s2"]'
assert_eq "batchPlan favors the heavier-weighted s2" "$(echo "$LSB" | jq -r '(.discovery.batchPlan | map(select(.slug=="s2"))[0].count) >= (.discovery.batchPlan | map(select(.slug=="s1"))[0].count)')" "true"
BADQ="$(api GET "/api/projects/$PROJECT_ID/lever-state?batchSize=abc")"
assert_eq "malformed batchSize is a 400" "$(echo "$BADQ" | jq -r 'has("error")')" "true"
# Registry drift: a strategy registered AFTER the tick has no stored weight yet
# — the plan must include it at the floor share (0.1 vs the weighted sum 1.0
# → ~9% of 30 ≥ 1), not omit it until the next tick.
R="$(api PUT "/api/projects/$PROJECT_ID/discovery-strategies" "$(jq -nc '{slug:"s3", approach:"e2e: post-tick strategy"}')")"
assert_eq "post-tick strategy s3 registered" "$(echo "$R" | jq -r '.slug // ""')" "s3"
LSC="$(api GET "/api/projects/$PROJECT_ID/lever-state")"
assert_eq "unweighted active s3 enters the plan at the floor share" "$(echo "$LSC" | jq -r '.discovery.batchPlan[] | select(.slug=="s3") | .count >= 1')" "true"
assert_eq "drifted batchPlan still sums to batchSize" "$(echo "$LSC" | jq -r '[.discovery.batchPlan[].count] | add')" "30"

step "get_lever_decisions (audit trend, read-only)"
LD="$(api GET "/api/projects/$PROJECT_ID/lever-decisions?days=30")"
assert_eq "history returns today's recorded decision" "$(echo "$LD" | jq -r '.decisions | length >= 1')" "true"
assert_eq "history newest measures v1 replies = 36" "$(echo "$LD" | jq -r '.decisions[0].samples[] | select(.variantId=="v1") | .responses')" "36"
assert_eq "history newest archived v3" "$(echo "$LD" | jq -rc '[.decisions[0].archived[].variantId]')" '["v3"]'
assert_eq "history newest channel affinity software_tech email-first" \
  "$(echo "$LD" | jq -r '.decisions[0].channelAffinity.software_tech[0].channel')" "email"
assert_eq "history newest carries the discovery decision" \
  "$(echo "$LD" | jq -r '.decisions[0].discovery.weights | has("s1") and has("s2")')" "true"
assert_eq "history newest carries configUsed" \
  "$(echo "$LD" | jq -r '.decisions[0].configUsed.strategyWeightFloor')" "0.1"
assert_eq "history newest carries vitals" \
  "$(echo "$LD" | jq -r '.decisions[0].vitals.verdict')" "ok"
# cycleDate is a bare date string (YYYY-MM-DD), not an ISO timestamp — guards the
# .toISOString() date-shape regression class the reader deliberately avoids.
assert_eq "history newest cycleDate is a bare date (no ISO time component)" \
  "$(echo "$LD" | jq -r '.decisions[0].cycleDate | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")')" "true"
# Default window applies when days omitted (no 400, returns the same history).
LD0="$(api GET "/api/projects/$PROJECT_ID/lever-decisions")"
assert_eq "history default window returns the decision" "$(echo "$LD0" | jq -r '.decisions | length >= 1')" "true"

step "get_outbound_targets surfaces per-prospect channel affinity"
RT="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=10")"
assert_eq "reachable prospect carries measured channel affinity" \
  "$(echo "$RT" | jq -rc '.prospects[0].channelAffinity[0].channel')" "email"

step "pick_message_variant draws from active survivors"
P1="$(api POST "/api/projects/$PROJECT_ID/message-variants/pick")"
PICKED="$(echo "$P1" | jq -r '.variantId // ""')"
case "$PICKED" in
  v1|v2) assert_eq "pick returns an active variant" "active" "active" ;;
  *)     assert_eq "pick returns an active variant" "$PICKED" "v1-or-v2" ;;
esac

step "pick explicit override + archived-id fall-through"
PE="$(api POST "/api/projects/$PROJECT_ID/message-variants/pick?variantId=v1")"
assert_eq "explicit v1 honored" "$(echo "$PE" | jq -r '.variantId')" "v1"
assert_eq "pick returns v1 bodyApproach" "$(echo "$PE" | jq -r '.bodyApproach | startswith("Problem-direct")')" "true"
PA="$(api POST "/api/projects/$PROJECT_ID/message-variants/pick?variantId=v3")"
PAID="$(echo "$PA" | jq -r '.variantId // ""')"
case "$PAID" in
  v1|v2) assert_eq "archived v3 falls through to draw" "active" "active" ;;
  *)     assert_eq "archived v3 falls through to draw" "$PAID" "v1-or-v2" ;;
esac

step "active cap: upserts up to maxActiveArms fit, one more is refused"
# Post-tick active set is {v1, v2}; default cap is 4.
for v in v4 v5; do
  R="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc --arg id "$v" '{variantId:$id, subjectPattern:("Hello {{org}} — "+$id), label:$id}')")"
  assert_eq "variant $v fits under the cap" "$(echo "$R" | jq -r '.variantId // ""')" "$v"
done
V6="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc '{variantId:"v6", subjectPattern:"Hello {{org}} — v6", label:"v6"}')")"
assert_eq "5th active variant refused" "$(echo "$V6" | jq -r '.error // ""')" "Active variant cap reached"
# Inserting straight to archived bypasses the cap (adds no active arm)...
V6A="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc '{variantId:"v6", subjectPattern:"Hello {{org}} — v6", label:"v6", archived:true}')")"
assert_eq "archived insert allowed at the cap" "$(echo "$V6A" | jq -r '.archivedAt != null')" "true"
# ...but un-archiving it is an activation and is refused.
V6U="$(api PUT "/api/projects/$PROJECT_ID/message-variants" "$(jq -nc '{variantId:"v6", subjectPattern:"Hello {{org}} — v6", archived:false}')")"
assert_eq "un-archive past the cap refused" "$(echo "$V6U" | jq -r '.error // ""')" "Active variant cap reached"

# Forgetting window (rewardLookbackDays). A separate project so the carefully
# tuned scenario above is untouched. One variant with sends at two ages: 40 in
# the band, 25 too old. With rewardLookbackDays=30 (and the default 14d maturity
# window) the band is [now-44d, now-14d): the tick measures only the 40, while
# the all-history /stats display still counts all 65. Same data, two windows.
step "forgetting window: second project + variant w1"
CREATE2="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME fw" '{name:$n}')")"
PROJECT_ID2="$(echo "$CREATE2" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID2" ]] || { echo "create-project(2) failed: $CREATE2" >&2; exit 1; }
say "project_id2=$PROJECT_ID2"
W1="$(api PUT "/api/projects/$PROJECT_ID2/message-variants" "$(jq -nc '{variantId:"w1", subjectPattern:"Hi {{org}} — w1", label:"w1"}')")"
assert_eq "variant w1 upserted" "$(echo "$W1" | jq -r '.variantId // ""')" "w1"

# Opt into a 30-day forgetting window (overrides-only jsonb; the row is seeded at
# create time). psql, matching how this harness sets up all lever fixtures.
psql_local "UPDATE project_settings SET lever_config = '{\"rewardLookbackDays\": 30}'::jsonb WHERE project_id = '$PROJECT_ID2';" > /dev/null
assert_eq "lever_config rewardLookbackDays persisted" \
  "$(psql_local "SELECT lever_config->>'rewardLookbackDays' FROM project_settings WHERE project_id='$PROJECT_ID2';")" "30"

step "backdate w1 sends: 40 in-band (30d) + 25 too-old (60d)"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
            SELECT '$TENANT_ID', '$PROJECT_ID2', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '30 days', 'w1'
            FROM generate_series(1, 40);" > /dev/null
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
            SELECT '$TENANT_ID', '$PROJECT_ID2', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '60 days', 'w1'
            FROM generate_series(1, 25);" > /dev/null
say "inserted 65 sends (40 @30d, 25 @60d); both ages are reply-mature (>14d)"

step "tick path measures the windowed count; /stats display measures all-history"
TF="$(api POST "/api/projects/$PROJECT_ID2/run-lever-tick")"
assert_eq "tick w1 windowed total (excludes the 25 too-old)" \
  "$(echo "$TF" | jq -r '.samples[] | select(.variantId=="w1") | .total')" "40"
assert_eq "tick needsReplenishment true (1 active < target 3)" "$(echo "$TF" | jq -r '.needsReplenishment')" "true"
# Vitals deliberately ignore the forgetting window: the whole regime counts.
assert_eq "tick vitals ignore the lookback (all 65 mature sends)" "$(echo "$TF" | jq -r '.vitals.sends')" "65"
SF="$(api GET "/api/projects/$PROJECT_ID2/stats")"
assert_eq "stats w1 all-history total (unwindowed = 65)" \
  "$(echo "$SF" | jq -r '.metrics.variantResponseRate[] | select(.variantId=="w1") | .total')" "65"

# Epoch cut (measurementsSince). A fourth project: sends and replies on both
# sides of a 45-days-ago epoch date. The tick must count only the post-epoch
# side (denominator AND reply/reward queries — both SQL fragments), while the
# all-history /stats display stays uncut. Exercises the ::date cast end-to-end:
# a broken fragment would 500 every tick.
step "epoch cut: fourth project + variant e1, measurementsSince 45d ago"
CREATE4="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME epoch" '{name:$n}')")"
PROJECT_ID4="$(echo "$CREATE4" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID4" ]] || { echo "create-project(4) failed: $CREATE4" >&2; exit 1; }
say "project_id4=$PROJECT_ID4"
E1="$(api PUT "/api/projects/$PROJECT_ID4/message-variants" "$(jq -nc '{variantId:"e1", subjectPattern:"Hi {{org}} — e1", label:"e1"}')")"
assert_eq "variant e1 upserted" "$(echo "$E1" | jq -r '.variantId // ""')" "e1"
# The shared prospect already carries discovery_strategy='s1' (set in the main
# flow); registering the slug here makes it an arm of THIS project's registry,
# so the discovery samples must show the same epoch cut as the variant samples.
ES="$(api PUT "/api/projects/$PROJECT_ID4/discovery-strategies" "$(jq -nc '{slug:"s1", approach:"e2e: epoch strategy"}')")"
assert_eq "epoch strategy s1 registered" "$(echo "$ES" | jq -r '.slug // ""')" "s1"
EPOCH_DATE="$(psql_local "SELECT (now() - interval '45 days')::date;")"
psql_local "UPDATE project_settings SET lever_config = '{\"measurementsSince\": \"$EPOCH_DATE\"}'::jsonb WHERE project_id = '$PROJECT_ID4';" > /dev/null
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
            SELECT '$TENANT_ID', '$PROJECT_ID4', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '30 days', 'e1'
            FROM generate_series(1, 20);" > /dev/null
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
            SELECT '$TENANT_ID', '$PROJECT_ID4', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '60 days', 'e1'
            FROM generate_series(1, 25);" > /dev/null
psql_local "INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at)
            SELECT tenant_id, id, 'email', 'e2e', 'positive', 'reply', sent_at + interval '1 day'
            FROM outreach_logs WHERE project_id='$PROJECT_ID4' AND sent_at < now() - interval '59 days' ORDER BY id LIMIT 5;" > /dev/null
psql_local "INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at)
            SELECT tenant_id, id, 'email', 'e2e', 'positive', 'reply', sent_at + interval '1 day'
            FROM outreach_logs WHERE project_id='$PROJECT_ID4' AND sent_at > now() - interval '31 days' ORDER BY id LIMIT 1;" > /dev/null
say "epoch=$EPOCH_DATE; inserted 20 sends + 1 reply post-epoch, 25 sends + 5 replies pre-epoch"

step "tick measures only post-epoch; /stats display stays all-history"
TE="$(api POST "/api/projects/$PROJECT_ID4/run-lever-tick")"
assert_eq "tick e1 post-epoch total (excludes the 25 pre-epoch)" \
  "$(echo "$TE" | jq -r '.samples[] | select(.variantId=="e1") | .total')" "20"
assert_eq "tick e1 post-epoch responses (excludes the 5 pre-epoch replies)" \
  "$(echo "$TE" | jq -r '.samples[] | select(.variantId=="e1") | .responses')" "1"
assert_eq "tick journal records measurementsSince in configUsed" \
  "$(api GET "/api/projects/$PROJECT_ID4/lever-decisions?days=1" | jq -r '.decisions[0].configUsed.measurementsSince')" "$EPOCH_DATE"
# The epoch must also cut the targeting aggregate feeding the strategy bandit
# (denominator AND reward query — pre-epoch rewardSum is 5, post-epoch is 1).
assert_eq "tick strategy s1 post-epoch total" \
  "$(echo "$TE" | jq -r '.discovery.samples[] | select(.slug=="s1") | .total')" "20"
assert_eq "tick strategy s1 post-epoch rewardSum" \
  "$(echo "$TE" | jq -r '.discovery.samples[] | select(.slug=="s1") | .rewardSum')" "1"
# The epoch cuts the vitals aggregate too; 20 sends is under futilityMinSends.
assert_eq "tick vitals post-epoch sends" "$(echo "$TE" | jq -r '.vitals.sends')" "20"
assert_eq "tick vitals verdict insufficient under the send floor" "$(echo "$TE" | jq -r '.vitals.verdict')" "insufficient"
SE="$(api GET "/api/projects/$PROJECT_ID4/stats")"
assert_eq "stats e1 all-history total (uncut = 45)" \
  "$(echo "$SE" | jq -r '.metrics.variantResponseRate[] | select(.variantId=="e1") | .total')" "45"
# Cross-field guard: a leverConfig whose effective target exceeds its cap is a
# clean 400 at the settings write (would wedge needsReplenishment vs the cap).
BADCFG="$(api PUT "/api/projects/$PROJECT_ID4/settings" "$(jq -nc '{leverConfig:{maxActiveStrategies:2}}')")"
assert_eq "target>cap lever config refused" "$(echo "$BADCFG" | jq -r '.error // ""')" "Invalid lever config"

# Stagnation rotation. A third project: 4 arms with mature, statistically flat
# data (40 sends each, 6/6/6/5 replies → max P(best) ≈ 0.29 < 0.5, weakest s4
# ≈ 0.14 — above the 0.05 dominance gate, so only the rotation can archive it),
# plus 6 seeded flat prior decisions = a 7-tick streak at the default
# stagnationTicks. The tick must rotate out s4 and keep needsReplenishment
# raised at targetActiveArms until the freed slot is refilled.
step "stagnation: third project + 4 flat mature arms"
CREATE3="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME stag" '{name:$n}')")"
PROJECT_ID3="$(echo "$CREATE3" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID3" ]] || { echo "create-project(3) failed: $CREATE3" >&2; exit 1; }
say "project_id3=$PROJECT_ID3"
for v in s1 s2 s3 s4; do
  R="$(api PUT "/api/projects/$PROJECT_ID3/message-variants" "$(jq -nc --arg id "$v" '{variantId:$id, subjectPattern:("Hey {{org}} — "+$id), label:$id}')")"
  assert_eq "variant $v upserted" "$(echo "$R" | jq -r '.variantId // ""')" "$v"
done

ins_stag() { # variant, sends, replies
  psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at, variant_id)
              SELECT '$TENANT_ID', '$PROJECT_ID3', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '30 days', '$1'
              FROM generate_series(1, $2);" > /dev/null
  psql_local "INSERT INTO responses (tenant_id, outreach_log_id, channel, content, sentiment, response_type, received_at)
              SELECT tenant_id, id, 'email', 'e2e', 'positive', 'reply', now() - interval '29 days'
              FROM outreach_logs WHERE project_id='$PROJECT_ID3' AND variant_id='$1' ORDER BY id LIMIT $3;" > /dev/null
}
ins_stag s1 40 6; ins_stag s2 40 6; ins_stag s3 40 6; ins_stag s4 40 5
say "inserted 160 sends + 23 replies (flat: no arm can reach P(best) >= 0.5)"

step "seed 6 flat prior decisions (streak = 6 history + today = stagnationTicks 7)"
STAG_DECISION='{"subject":{"weights":{"s1":0.3,"s2":0.3,"s3":0.25,"s4":0.15},"pBest":{"s1":0.3,"s2":0.3,"s3":0.25,"s4":0.15},"archived":[],"samples":[{"variantId":"s1","total":40,"responses":6,"rewardSum":6},{"variantId":"s2","total":40,"responses":6,"rewardSum":6},{"variantId":"s3","total":40,"responses":6,"rewardSum":6},{"variantId":"s4","total":40,"responses":5,"rewardSum":5}]}}'
for i in 1 2 3 4 5 6; do
  psql_local "INSERT INTO lever_decisions (tenant_id, project_id, cycle_date, decision)
              VALUES ('$TENANT_ID', '$PROJECT_ID3', (now() AT TIME ZONE 'UTC')::date - $i, '$STAG_DECISION'::jsonb);" > /dev/null
done
say "seeded lever_decisions for the previous 6 UTC days"

step "run_lever_tick rotates out the weakest arm"
TS1="$(api POST "/api/projects/$PROJECT_ID3/run-lever-tick")"
assert_eq "stag tick ran" "$(echo "$TS1" | jq -r '.ran')" "true"
assert_eq "stag tick archived exactly s4" "$(echo "$TS1" | jq -rc '[.archived[].variantId]')" '["s4"]'
assert_eq "stag archive carries reason stagnation" "$(echo "$TS1" | jq -r '.archived[0].reason // ""')" "stagnation"
assert_eq "stag archived pBest above the dominance gate" "$(echo "$TS1" | jq -r '.archived[0].pBest >= 0.05')" "true"
assert_eq "stag weights drop s4" "$(echo "$TS1" | jq -r '.weights | has("s4")')" "false"
assert_eq "stag pBest keeps the full arm set" "$(echo "$TS1" | jq -r '.pBest | has("s4")')" "true"
assert_eq "stag tick needsReplenishment (rotation slot unfilled)" "$(echo "$TS1" | jq -r '.needsReplenishment')" "true"

step "needsReplenishment stays raised at targetActiveArms until fulfillment"
# 3 active == targetActiveArms — the naive below-target signal is false, so
# this asserts the unfulfilled-rotation derivation specifically.
LS3="$(api GET "/api/projects/$PROJECT_ID3/lever-state")"
assert_eq "state 3 active after rotation" "$(echo "$LS3" | jq -r '.variants | length')" "3"
assert_eq "state needsReplenishment raised by unfulfilled rotation" "$(echo "$LS3" | jq -r '.needsReplenishment')" "true"
# Widen the cap so the cleared-side assertions below are decided by the
# fulfillment legs, never the active >= maxActiveArms short-circuit.
psql_local "UPDATE project_settings SET lever_config = '{\"maxActiveArms\": 5}'::jsonb WHERE project_id = '$PROJECT_ID3';" > /dev/null

step "count-growth fulfillment: un-archiving refills the slot without a fresh row"
S4B="$(api PUT "/api/projects/$PROJECT_ID3/message-variants" "$(jq -nc '{variantId:"s4", subjectPattern:"Hey {{org}} — s4", archived:false}')")"
assert_eq "s4 un-archived (no new row created)" "$(echo "$S4B" | jq -r '.archivedAt')" "null"
LS3B="$(api GET "/api/projects/$PROJECT_ID3/lever-state")"
assert_eq "pool growth past post-rotation size clears the flag (no fresh row exists)" "$(echo "$LS3B" | jq -r '.needsReplenishment')" "false"
# Re-archiving drops the pool back to post-rotation size: the count leg is
# live, and with still no fresh row the rotation flips back to unfulfilled.
api PUT "/api/projects/$PROJECT_ID3/message-variants" "$(jq -nc '{variantId:"s4", subjectPattern:"Hey {{org}} — s4", archived:true}')" > /dev/null
LS3C="$(api GET "/api/projects/$PROJECT_ID3/lever-state")"
assert_eq "re-archive re-raises the flag (count leg is live)" "$(echo "$LS3C" | jq -r '.needsReplenishment')" "true"

step "fresh-row fulfillment: a new slug clears it even at post-rotation size"
S5="$(api PUT "/api/projects/$PROJECT_ID3/message-variants" "$(jq -nc '{variantId:"s5", subjectPattern:"Hey {{org}} — s5", label:"s5"}')")"
assert_eq "fresh variant s5 upserted" "$(echo "$S5" | jq -r '.variantId // ""')" "s5"
# Archive an original arm so the pool sits exactly at post-rotation size:
# the count leg is false, so only the fresh-row leg can clear the flag.
api PUT "/api/projects/$PROJECT_ID3/message-variants" "$(jq -nc '{variantId:"s1", subjectPattern:"Hey {{org}} — s1", archived:true}')" > /dev/null
LS3D="$(api GET "/api/projects/$PROJECT_ID3/lever-state")"
assert_eq "state 3 active again (s2, s3, s5)" "$(echo "$LS3D" | jq -r '.variants | length')" "3"
assert_eq "fresh s5 clears the flag at post-rotation size (fresh-row leg)" "$(echo "$LS3D" | jq -r '.needsReplenishment')" "false"

step "idempotent echo keeps the rotation marker"
TS2="$(api POST "/api/projects/$PROJECT_ID3/run-lever-tick")"
assert_eq "stag tick2 ran=false" "$(echo "$TS2" | jq -r '.ran')" "false"
assert_eq "stag tick2 echoes reason stagnation" "$(echo "$TS2" | jq -r '.archived[0].reason // ""')" "stagnation"
assert_eq "stag tick2 needsReplenishment false (fulfilled)" "$(echo "$TS2" | jq -r '.needsReplenishment')" "false"

# Futility (vitals). A fifth project: 600 mature zero-reply email sends put
# P(rate < 1%) ≈ 0.998 past the 0.99 confidence gate. The futile verdict on the
# newest decision must surface on the tenant-wide attention feed; the healthy
# main project must not.
step "futility: fifth project + 600 zero-reply mature sends"
CREATE5="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME futile" '{name:$n}')")"
PROJECT_ID5="$(echo "$CREATE5" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID5" ]] || { echo "create-project(5) failed: $CREATE5" >&2; exit 1; }
say "project_id5=$PROJECT_ID5"
psql_local "INSERT INTO outreach_logs (tenant_id, project_id, prospect_id, channel, body, status, sent_at)
            SELECT '$TENANT_ID', '$PROJECT_ID5', $PROSPECT_ID, 'email', 'e2e', 'sent', now() - interval '30 days'
            FROM generate_series(1, 600);" > /dev/null
say "inserted 600 mature sends, zero replies"

step "tick judges futile; /me/attention surfaces exactly the futile project"
TV="$(api POST "/api/projects/$PROJECT_ID5/run-lever-tick")"
assert_eq "futility tick vitals sends" "$(echo "$TV" | jq -r '.vitals.sends')" "600"
assert_eq "futility tick vitals verdict" "$(echo "$TV" | jq -r '.vitals.verdict')" "futile"
assert_eq "futility tick pDead past the confidence gate" "$(echo "$TV" | jq -r '.vitals.pDead >= 0.99')" "true"
ATT="$(api GET "/api/me/attention")"
assert_eq "attention feed carries the futile project" \
  "$(echo "$ATT" | jq -r --arg n "$PROJECT_NAME futile" '[.items[] | select(.kind=="outreach_futility" and .projectName==$n)] | length')" "1"
assert_eq "attention futility carries the measured counts" \
  "$(echo "$ATT" | jq -r --arg n "$PROJECT_NAME futile" '.items[] | select(.kind=="outreach_futility" and .projectName==$n) | "\(.sends)/\(.replies)"')" "600/0"
assert_eq "healthy main project raises no futility item" \
  "$(echo "$ATT" | jq -r --arg n "$PROJECT_NAME" '[.items[] | select(.kind=="outreach_futility" and .projectName==$n)] | length')" "0"

step "add_prospects registry gate: unknown skips, archived accepted, upsert revives"
mkbatch() { # tag slug
  jq -nc --arg pid "$PROJECT_ID" --arg d "$RUN_TAG-$1.example" --arg e "contact@$RUN_TAG-$1.example" --arg n "P-$1" --arg s "$2" \
    '{projectId:$pid, prospects:[{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed", discoveryStrategy:$s}]}'
}
GB="$(api POST /api/prospects/batch "$(mkbatch ghost ghost-src)")"
assert_eq "unregistered slug skips the row as unknown_strategy" \
  "$(echo "$GB" | jq -r '"\(.inserted)/\(.skippedDetails[0].reason // "")"')" "0/unknown_strategy"
api PUT "/api/projects/$PROJECT_ID/discovery-strategies" "$(jq -nc '{slug:"s2", approach:"e2e: unsent strategy", archived:true}')" > /dev/null
AB="$(api POST /api/prospects/batch "$(mkbatch arch s2)")"
assert_eq "registered-but-archived slug accepted as provenance" "$(echo "$AB" | jq -r '.inserted')" "1"
RV="$(api PUT "/api/projects/$PROJECT_ID/discovery-strategies" "$(jq -nc '{slug:"s2", approach:"e2e: unsent strategy (refined)"}')")"
assert_eq "re-upsert without archived revives the slug" "$(echo "$RV" | jq -r '.archivedAt // "active"')" "active"

echo "" >&2
printf 'RESULT: %d passed, %d failed\n' "$PASS" "$FAIL" >&2
[[ "$FAIL" -eq 0 ]] || exit 2
