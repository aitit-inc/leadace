#!/usr/bin/env bash
# Cloud-edition regression: the hosted chat's plan allowance (MAIN_CHAT_LIMITS
# in services/plan-limits.ts, spent by services/chat/threads.ts postMessage and
# by each scheduled run in api/schedule-runner.ts).
#
# Free allows 60 messages over the tenant lifetime. The count lives in
# chat_rate_windows (scope main_chat_allowance), so the suite seeds it at 58:
# a scheduled run spends message 59 and its turn runs, message 60 goes through,
# message 61 is refused with the limit sentence and leaves the thread and its
# waiting approval card untouched, the next scheduled run is refused before its
# turn and recorded as the schedule's failure, and approving that card still
# runs the call without spending a message.
#
# Then on Starter (150 per billing period) with 150 spent: prepaid credits pay
# for message 151 ($0.20, one ledger row named by its count), and a balance
# below the unit price refuses message 152 with the credits sentence.
#
# The scheduled run, the accepted message and the approval each take a short
# model turn (the backend's LLM key from backend/.dev.vars).
#
# The scheduled-run steps fire the whole hourly cron, so they run only when no
# other tenant has an enabled schedule or a sending identity for it to act on
# (a dedicated database, such as an isolated stack). Otherwise they are skipped
# and the suite seeds 59.
#
# Targets the cloud worker on :8789 (override API_URL); start it with
# ./e2e/cloud-edition-up.sh, which also exposes /__scheduled to fire the cron.
#
# Usage:
#   ./e2e/regression-cloud-chat-quota.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-chat-quota.sh
#
# Exit status: 0 all pass / 1 setup or HTTP step failed / 2 assertion mismatch

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TS="$(date +%s)"
EMAIL="e2e-cloud-main-chat-$TS@example.com"
source "$REPO_ROOT/e2e/lib-cloud.sh"

trap cloud_teardown EXIT

require_jq
API_OUT="$(mktemp)"
cloud_preflight
cloud_init_admin
cloud_provision_tenant "$EMAIL"
T="$THROW_TENANT_ID"
cloud_seed_plan "$T" free

post_msg() { api_status POST "/api/chat/threads/$1/messages" "$(jq -nc --arg t "$2" '{text:$t}')"; }
chat_used() { api GET /api/me/plan | jq -r '.chat | "\(.kind) \(.window) \(.used)/\(.limit) left=\(.remaining)"'; }
# The schedule is made due at the instant the cron fires at, so an hour
# turning over in between cannot leave it not due (1970-01-01 was a Thursday).
# The run goes on after the request returns.
fire_schedule() {
  local now; now="$(date -u +%s)"
  psql_local "UPDATE schedules SET timezone = 'UTC', hour = $((now / 3600 % 24)), days_of_week = $((1 << ((now / 86400 + 4) % 7))), last_run_key = NULL
    WHERE id = '$SCHED';" > /dev/null
  curl -sS -o /dev/null "$API_URL/__scheduled?cron=0+*+*+*+*&time=$((now * 1000))"
}
sched_field() { psql_local "SELECT $1 FROM schedules WHERE id = '$SCHED';"; }
# The turn is over once the thread ends on a model reply that calls nothing.
turn_done() {
  psql_local "SELECT role = 'model' AND NOT jsonb_path_exists(content, '\$.parts[*].functionCall')
    FROM chat_messages WHERE thread_id = '$1' ORDER BY id DESC LIMIT 1;"
}

step "seed: a project, a thread to talk in, and a thread whose card waits for approval"
PROJ="$(api POST /api/projects "$(jq -nc '{name:"main-chat quota"}')" | jq -r '.id // ""')"
[[ -n "$PROJ" ]] || { echo "project create failed" >&2; exit 1; }
psql_local "UPDATE project_settings SET outbound_mode = 'draft' WHERE project_id = '$PROJ' AND tenant_id = '$T';" > /dev/null
TALK="$(api POST /api/chat/threads "$(jq -nc --arg p "$PROJ" '{projectId:$p}')" | jq -r '.id // ""')"
CARD="$(api POST /api/chat/threads "$(jq -nc --arg p "$PROJ" '{projectId:$p, title:"Run it on its own"}')" | jq -r '.id // ""')"
[[ -n "$TALK" && -n "$CARD" ]] || { echo "thread create failed" >&2; exit 1; }

CALL="call_e2e_$TS"
psql_local "INSERT INTO chat_messages (tenant_id, thread_id, role, content, read_after) VALUES
  ('$T', '$CARD', 'user', '{\"role\":\"user\",\"parts\":[{\"text\":\"Let the runs send on their own.\"}]}'::jsonb, 0);" > /dev/null
MSG="$(psql_local "INSERT INTO chat_messages (tenant_id, thread_id, role, content, read_after) VALUES
  ('$T', '$CARD', 'model', '{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"id\":\"$CALL\",\"name\":\"update_project_settings\",\"args\":{\"projectId\":\"$PROJ\",\"outboundMode\":\"send\"}}}]}'::jsonb, 0)
  RETURNING id;" | head -1)"
# The summary the tool's confirm builds now, so approving runs the call
# instead of raising the card again with new terms.
PENDING="$(jq -nc --argjson m "$MSG" --arg c "$CALL" --arg p "$PROJ" '{messageId:$m, callId:$c, name:"update_project_settings",
  args:{projectId:$p, outboundMode:"send"},
  summary:{title:"Send without review", facts:[{label:"Project", value:"main-chat quota"}], confirmLabel:"Send without review"},
  otherResponses:[], remaining:[]}')"
psql_local "UPDATE chat_threads SET pending_call = '$PENDING'::jsonb WHERE id = '$CARD';" > /dev/null

CRON_SAFE="$(psql_local "SELECT NOT EXISTS (SELECT 1 FROM schedules WHERE enabled AND tenant_id <> '$T')
  AND NOT EXISTS (SELECT 1 FROM sending_identities WHERE tenant_id <> '$T');")"
[[ "$CRON_SAFE" == "t" ]] && SEED=58 || SEED=59

step "the plan page reports the allowance"
assert_eq "fresh free tenant: 60 lifetime, none used" "$(chat_used)" "capped lifetime 0/60 left=60"

psql_local "INSERT INTO chat_rate_windows (tenant_id, scope, key, window_start, used)
  VALUES ('$T', 'main_chat_allowance', '$T', to_timestamp(0), $SEED);" > /dev/null
assert_eq "$SEED spent" "$(chat_used)" "capped lifetime $SEED/60 left=$((60 - SEED))"

SCHED_THREAD=""
if [[ "$CRON_SAFE" == "t" ]]; then
  step "a scheduled run spends message 59"
  SCHED="$(api POST /api/schedules "$(jq -nc --arg p "$PROJ" '{projectId:$p, prompt:"Reply with the single word OK. Call no tools.", hour:0, timezone:"UTC", days:[0]}')" | jq -r '.id // ""')"
  [[ -n "$SCHED" ]] || { echo "schedule create failed" >&2; exit 1; }
  fire_schedule
  for _ in $(seq 1 90); do
    SCHED_THREAD="$(sched_field "coalesce(thread_id, '')")"
    [[ -n "$SCHED_THREAD" && "$(turn_done "$SCHED_THREAD")" == "t" ]] && break
    sleep 1
  done
  [[ -n "$SCHED_THREAD" ]] || { echo "the scheduled run never started" >&2; exit 1; }
  assert_eq "its turn answered" "$(turn_done "$SCHED_THREAD")" "t"
  assert_eq "one message spent" "$(chat_used)" "capped lifetime 59/60 left=1"
  assert_eq "no failure recorded" "$(sched_field "consecutive_failures || ' ' || coalesce(last_error, '-')")" "0 -"
else
  say "skipping the scheduled-run steps: other tenants here have schedules or mailboxes the cron would act on; run on a dedicated database"
fi

step "message 60 goes through"
assert_eq "message 60 → 201" "$(post_msg "$TALK" "What should I do next?")" "201"
assert_eq "all 60 spent" "$(chat_used)" "capped lifetime 60/60 left=0"

step "message 61 is refused, and the waiting card stays"
CARD_MSGS="$(psql_local "SELECT count(*) FROM chat_messages WHERE thread_id = '$CARD';")"
assert_eq "message 61 → 403" "$(post_msg "$CARD" "One more thing")" "403"
DETAIL="$(api_body | jq -r '.detail // ""')"
say "refusal: $DETAIL"
[[ "$DETAIL" == *"60 chat messages in total"* && "$DETAIL" == *"plans page"* ]] \
  && assert_eq "refusal names the limit and the plans page" "yes" "yes" \
  || assert_eq "refusal names the limit and the plans page" "$DETAIL" "…60 chat messages in total…plans page…"
assert_eq "nothing written to the thread" "$(psql_local "SELECT count(*) FROM chat_messages WHERE thread_id = '$CARD';")" "$CARD_MSGS"
assert_eq "card still waiting" "$(psql_local "SELECT pending_call ->> 'callId' FROM chat_threads WHERE id = '$CARD';")" "$CALL"
assert_eq "still 60 spent" "$(chat_used)" "capped lifetime 60/60 left=0"

if [[ "$CRON_SAFE" == "t" ]]; then
  step "the next scheduled run is refused before its turn"
  SCHED_MSGS="$(psql_local "SELECT count(*) FROM chat_messages WHERE thread_id = '$SCHED_THREAD';")"
  fire_schedule
  for _ in $(seq 1 30); do [[ "$(sched_field consecutive_failures)" == "1" ]] && break; sleep 1; done
  assert_eq "recorded as a failure" "$(sched_field consecutive_failures)" "1"
  LAST_ERROR="$(sched_field last_error)"
  say "last_error: $LAST_ERROR"
  [[ "$LAST_ERROR" == "Chat message limit reached"*"60 chat messages in total"* ]] \
    && assert_eq "the failure is the limit sentence" "yes" "yes" \
    || assert_eq "the failure is the limit sentence" "$LAST_ERROR" "Chat message limit reached…60 chat messages in total…"
  assert_eq "still on (one failure)" "$(sched_field enabled)" "t"
  assert_eq "nothing written to its thread" "$(psql_local "SELECT count(*) FROM chat_messages WHERE thread_id = '$SCHED_THREAD';")" "$SCHED_MSGS"
  assert_eq "the run spent nothing" "$(chat_used)" "capped lifetime 60/60 left=0"
  # The failure count commits before the notification is written.
  NOTICE=""
  for _ in $(seq 1 15); do
    NOTICE="$(psql_local "SELECT subject FROM notifications WHERE tenant_id = '$T' AND reference LIKE 'schedule:$SCHED:%';")"
    [[ -n "$NOTICE" ]] && break
    sleep 1
  done
  assert_eq "the person is notified" "$NOTICE" "A LeadAce scheduled run failed"
fi

step "approving the card still runs the call"
assert_eq "confirm → 204" "$(api_status POST "/api/chat/threads/$CARD/confirm" "$(jq -nc --arg c "$CALL" '{callId:$c, approve:true}')")" "204"
MODE=""
for _ in $(seq 1 60); do
  MODE="$(psql_local "SELECT outbound_mode FROM project_settings WHERE project_id = '$PROJ';")"
  [[ "$MODE" == "send" ]] && break
  sleep 1
done
assert_eq "the approved call ran (outbound_mode)" "$MODE" "send"
assert_eq "card answered" "$(psql_local "SELECT pending_call IS NULL FROM chat_threads WHERE id = '$CARD';")" "t"
assert_eq "approval spent nothing" "$(chat_used)" "capped lifetime 60/60 left=0"

step "past a paid plan's allowance, credits pay for a message"
cloud_seed_plan "$T" starter
# Stripe periods start on a whole second; NOW() carries microseconds a JS Date drops.
psql_local "UPDATE tenant_plans SET current_period_start = date_trunc('second', current_period_start) WHERE tenant_id = '$T';" > /dev/null
psql_local "INSERT INTO chat_rate_windows (tenant_id, scope, key, window_start, used)
  SELECT '$T', 'main_chat_allowance', '$T', current_period_start, 150 FROM tenant_plans WHERE tenant_id = '$T';" > /dev/null
psql_local "INSERT INTO credit_ledger (tenant_id, kind, amount_cents, reference) VALUES ('$T', 'purchase', 30, 'cs_e2e_$TS');" > /dev/null
balance() { psql_local "SELECT COALESCE(SUM(amount_cents), 0)::int FROM credit_ledger WHERE tenant_id = '$T';"; }
assert_eq "starter: 150 of 150 spent" "$(chat_used)" "capped monthly 150/150 left=0"
assert_eq "message 151 → 201" "$(post_msg "$TALK" "And after that?")" "201"
assert_eq "debited \$0.20" "$(balance)" "10"
assert_eq "one chat debit, named by its count" \
  "$(psql_local "SELECT count(*) || ' ' || bool_and(reference LIKE 'chat:%:151')::text FROM credit_ledger WHERE tenant_id = '$T' AND kind = 'usage_chat';")" "1 true"
assert_eq "151 counted" "$(chat_used)" "capped monthly 151/150 left=0"

step "a balance below \$0.20 refuses the next message"
assert_eq "message 152 → 403" "$(post_msg "$TALK" "One more")" "403"
DETAIL="$(api_body | jq -r '.detail // ""')"
say "refusal: $DETAIL"
[[ "$DETAIL" == *"150 chat messages per billing period"* && "$DETAIL" == *"buy credits"* ]] \
  && assert_eq "refusal names the limit and credits" "yes" "yes" \
  || assert_eq "refusal names the limit and credits" "$DETAIL" "…150 chat messages per billing period…buy credits…"
assert_eq "nothing debited" "$(balance)" "10"
assert_eq "still 151 counted" "$(chat_used)" "capped monthly 151/150 left=0"

# Teardown deletes the tenant; a turn still writing to it would fail on the FK.
for thread in "$TALK" "$CARD" ${SCHED_THREAD:+"$SCHED_THREAD"}; do
  for _ in $(seq 1 90); do
    [[ "$(psql_local "SELECT role FROM chat_messages WHERE thread_id = '$thread' ORDER BY id DESC LIMIT 1;")" == "model" ]] && break
    sleep 1
  done
done

cloud_summary
