#!/usr/bin/env bash
# Regression for the per-mailbox warmup send cap (G3 slice 1):
#   domain/warmup.ts mailboxDailyCap + services/plan-limits.ts getMailboxDailyQuota
#   + outreach.ts enforcement/stamp + prospects.ts listReachable surfacing.
#
# The pure ramp math is unit-tested (domain/warmup.test.ts). This drives the
# DB-coupled behavior the unit layer can't reach, against the local stack
# (localhost:8787 API + 54322 Postgres):
#
#   1. Ramp wiring: warmup_started_at 15d ago (week 2), no override → the cap
#      surfaced by get_outbound_targets is the week-2 ramp step (17 for the
#      {10,4w,25} default). Confirms the column feeds mailboxDailyCap.
#   2. First-send stamp: a never-sent mailbox (warmup_started_at NULL) gets it
#      stamped on the first EMAIL send (starts the ramp clock at first use).
#   3. Email-only counting: each EMAIL send increments mailboxQuota.used.
#   4. Threshold block: the send past the cap is rejected (HTTP 403).
#   5. Channel isolation: a FORM send is NOT blocked by the (email-only) cap.
#
# Also covers the project-scoped read endpoint GET /projects/:id/mailbox-health
# (services/mailbox.ts getProjectMailboxHealth → plan-limits.ts getMailboxHealth):
# it resolves the project's sending identity (here the gmail fallback), mirrors the
# surfaced cap, exposes ramp progress (rampWeek/rampWeeks/steadyStatePerDay), and
# reports a pause (cap 0 + pausedUntil) — see steps 1b/1c.
#
# And the per-identity operator write path PUT /me/sending-identities/:id/warmup
# (updateMailboxWarmup) — step 6: override / partial patch / pause / resume / no
# started_at write / 400s.
#
# Baseline-robust: the tenant may already have EMAIL sends today (the cap is
# per-tenant, not per-project). Tests that need an exact threshold disable the
# ramp and set daily_cap_override relative to the measured baseline, so a
# non-empty day doesn't skew the assertions.
#
# Does NOT delete the tenant's real Gmail sending_identities row: it snapshots and
# restores the four warmup columns (or removes a dummy row it inserted itself).
# Relies on the tenant being compliance-ready (legalName / physicalAddress /
# defaultSenderCountry set) and on US sends being allowed — same baseline as
# regression-followup-sequence.sh. If the first send is not 2xx, that is the
# likely cause.
#
# Curl-only, no Claude session / Anthropic budget. Single tenant, one project,
# cleans up.
#
# Usage:
#   ./e2e/regression-mailbox-warmup.sh
#   SKIP_CLEANUP=1 ./e2e/regression-mailbox-warmup.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-warmup-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"

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

reach()    { api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200"; }
mq()       { reach | jq -r ".mailboxQuota.$1"; }
# Project-scoped health: the test project has no assigned sending identity, so it
# resolves the gmail fallback — the same row the warmup columns are set on below.
mh()       { api GET "/api/projects/$PROJECT_ID/mailbox-health" | jq -r ".$1"; }
started_null() { psql_local "SELECT (warmup_started_at IS NULL) FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';"; }

# PUT a partial warmup patch to the gmail identity; first echoes the health body,
# second the status code.
put_warmup()        { api PUT "/api/me/sending-identities/$GMAIL_IDENTITY_ID/warmup" "$1"; }
put_warmup_status() { curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$1" "$API_URL/api/me/sending-identities/$GMAIL_IDENTITY_ID/warmup"; }

# Set the four warmup columns. Args are raw SQL fragments (NULL / number /
# NOW()-expr) so callers control nullability precisely.
set_warmup() { # enabled started_at override paused
  psql_local "UPDATE sending_identities SET warmup_enabled=$1, warmup_started_at=$2, daily_cap_override=$3, paused_until=$4 WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';" >/dev/null
}

# POST a 'sent' outreach; echoes only the HTTP status code.
send_status() { # prospectId channel
  curl -sS -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" --arg ch "$2" \
      '{projectId:$pid, prospectId:$prid, channel:$ch, subject:"e2e", body:"seed", status:"sent"}')" \
    "$API_URL/api/outreach"
}

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

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
say "tenant_id=$TENANT_ID"

# Snapshot the mailbox so we never destroy a real connected Gmail row. If a row
# exists, capture the four warmup columns (empty string = SQL NULL) and restore
# them on teardown; if not, insert a dummy and delete it on teardown.
HAD_GMAIL="$(psql_local "SELECT EXISTS(SELECT 1 FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth');")"
SNAP_ENABLED=""; SNAP_STARTED=""; SNAP_OVERRIDE=""; SNAP_PAUSED=""
if [[ "$HAD_GMAIL" == "t" ]]; then
  # plain boolean → 't'/'f' (NOT ::text, which renders 'true'/'false' and would
  # never match the == 't' check in restore_and_exit, silently forcing false).
  SNAP_ENABLED="$(psql_local "SELECT warmup_enabled FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';")"
  SNAP_STARTED="$(psql_local "SELECT COALESCE(warmup_started_at::text,'') FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';")"
  SNAP_OVERRIDE="$(psql_local "SELECT COALESCE(daily_cap_override::text,'') FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';")"
  SNAP_PAUSED="$(psql_local "SELECT COALESCE(paused_until::text,'') FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';")"
  say "snapshotted existing mailbox warmup state"
else
  psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret)
    VALUES ('$TENANT_ID', replace(gen_random_uuid()::text,'-',''), '$USER_ID', 'gmail_oauth', 'e2e-warmup@example.com', 'https://www.googleapis.com/auth/gmail.send', decode('00','hex'));" >/dev/null
  say "inserted dummy mailbox row"
fi

# Resolve the gmail identity_id now the row is guaranteed to exist — the
# per-identity warmup write path (step 6) addresses the mailbox by id.
GMAIL_IDENTITY_ID="$(api GET /api/me/sending-identities | jq -r '.identities[] | select(.provider=="gmail_oauth") | .identityId' | head -1)"
[[ -n "$GMAIL_IDENTITY_ID" ]] || { echo "could not resolve gmail identity_id" >&2; exit 1; }
say "gmail_identity_id=$GMAIL_IDENTITY_ID"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ "$HAD_GMAIL" == "t" ]]; then
    local enabled_sql started_sql override_sql paused_sql
    enabled_sql="$([[ "$SNAP_ENABLED" == "t" ]] && echo true || echo false)"
    started_sql="$([[ -z "$SNAP_STARTED" ]] && echo NULL || echo "'$SNAP_STARTED'")"
    override_sql="$([[ -z "$SNAP_OVERRIDE" ]] && echo NULL || echo "$SNAP_OVERRIDE")"
    paused_sql="$([[ -z "$SNAP_PAUSED" ]] && echo NULL || echo "'$SNAP_PAUSED'")"
    set_warmup "$enabled_sql" "$started_sql" "$override_sql" "$paused_sql"
    say "restored mailbox warmup state"
  else
    psql_local "DELETE FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth' AND user_id='$USER_ID';" >/dev/null || true
    say "removed dummy mailbox row"
  fi
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID (outreach_logs cascade)"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed 4 US prospects (3 email targets + 1 form target)"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_id=$PROJECT_ID"
SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed e1)" --argjson b "$(mkseed e2)" --argjson c "$(mkseed e3)" --argjson d "$(mkseed form)" \
  '{projectId:$pid, prospects:[$a,$b,$c,$d]}')"
assert_eq "seed inserted=4" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "4"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email==$e) | .prospectId' | head -1; }
P_E1="$(pid_of e1)"; P_E2="$(pid_of e2)"; P_E3="$(pid_of e3)"; P_FORM="$(pid_of form)"
[[ -n "$P_E1" && -n "$P_E2" && -n "$P_E3" && -n "$P_FORM" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }
say "e1=$P_E1 e2=$P_E2 e3=$P_E3 form=$P_FORM"

# Baseline: the tenant's EMAIL sends already counted today (cap is per-tenant).
BASELINE="$(mq used)"
[[ "$BASELINE" =~ ^[0-9]+$ ]] || { echo "could not read baseline mailboxQuota.used (got: $BASELINE)" >&2; exit 1; }
say "baseline email used today=$BASELINE"

step "1. ramp wiring: 15d-old mailbox (week 2) surfaces the week-2 ramp cap (17)"
set_warmup true "NOW() - INTERVAL '15 days'" NULL NULL
assert_eq "mailboxQuota.kind=capped" "$(mq kind)" "capped"
assert_eq "ramp cap = week-2 step (17)" "$(mq cap)" "17"

step "1b. /projects/:id/mailbox-health mirrors the cap and surfaces ramp progress"
assert_eq "health kind=active" "$(mh kind)" "active"
assert_eq "health cap = week-2 step (17)" "$(mh cap)" "17"
assert_eq "health rampWeek=2" "$(mh rampWeek)" "2"
assert_eq "health rampWeeks=4" "$(mh rampWeeks)" "4"
assert_eq "health steadyStatePerDay=25" "$(mh steadyStatePerDay)" "25"
assert_eq "health warmupEnabled=true" "$(mh warmupEnabled)" "true"

step "1c. paused mailbox: health caps at 0 and reports the pause"
set_warmup true "NOW() - INTERVAL '15 days'" NULL "NOW() + INTERVAL '1 day'"
assert_eq "health still active" "$(mh kind)" "active"
assert_eq "health cap=0 while paused" "$(mh cap)" "0"
assert_eq "health pausedUntil present" "$([[ "$(mh pausedUntil)" == null || -z "$(mh pausedUntil)" ]] && echo absent || echo present)" "present"

step "2. first EMAIL send stamps warmup_started_at (ramp clock starts at first use)"
# Disable ramp + high override so the send itself can't be blocked; isolate the stamp.
set_warmup false NULL "$((BASELINE + 10))" NULL
assert_eq "pre: warmup_started_at IS NULL" "$(started_null)" "t"
assert_eq "email send e1 → 2xx" "$(send_status "$P_E1" email | cut -c1)" "2"
assert_eq "post: warmup_started_at stamped" "$(started_null)" "f"
assert_eq "email send counted (used = baseline+1)" "$(mq used)" "$((BASELINE + 1))"

step "3+4. threshold block + email-only counting (cap = baseline+2)"
set_warmup false NULL "$((BASELINE + 2))" NULL
assert_eq "remaining = 1 (cap baseline+2, used baseline+1)" "$(mq remaining)" "1"
assert_eq "email send e2 → 2xx (reaches cap)" "$(send_status "$P_E2" email | cut -c1)" "2"
assert_eq "remaining = 0 at cap" "$(mq remaining)" "0"
assert_eq "email send e3 past cap → 403" "$(send_status "$P_E3" email)" "403"

step "5. channel isolation: FORM send is NOT blocked by the email-only cap"
assert_eq "form send → 2xx despite email cap exhausted" "$(send_status "$P_FORM" form | cut -c1)" "2"
assert_eq "email used unchanged by form send (baseline+2)" "$(mq used)" "$((BASELINE + 2))"

step "6. operator write path: PUT /me/sending-identities/:id/warmup"
# Known state: week-2 ramp (cap 17), no override, not paused.
set_warmup true "NOW() - INTERVAL '15 days'" NULL NULL

W6A="$(put_warmup '{"dailyCapOverride":5}')"
assert_eq "6a put kind=active" "$(echo "$W6A" | jq -r .kind)" "active"
assert_eq "6a override applied (cap=min(17,5)=5)" "$(echo "$W6A" | jq -r .cap)" "5"
assert_eq "6a dailyCapOverride=5" "$(echo "$W6A" | jq -r .dailyCapOverride)" "5"
assert_eq "6a write hit DB (daily_cap_override=5)" "$(psql_local "SELECT daily_cap_override FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth';")" "5"

W6B="$(put_warmup '{"warmupEnabled":false}')"
assert_eq "6b warmupEnabled=false" "$(echo "$W6B" | jq -r .warmupEnabled)" "false"
assert_eq "6b dailyCapOverride untouched (5)" "$(echo "$W6B" | jq -r .dailyCapOverride)" "5"
assert_eq "6b cap = override (warmup off → 5)" "$(echo "$W6B" | jq -r .cap)" "5"

W6C="$(put_warmup '{"pausedUntil":"2030-01-01T00:00:00Z"}')"
assert_eq "6c cap=0 while paused" "$(echo "$W6C" | jq -r .cap)" "0"
assert_eq "6c pausedUntil present" "$([[ "$(echo "$W6C" | jq -r .pausedUntil)" == null ]] && echo absent || echo present)" "present"

W6D="$(put_warmup '{"pausedUntil":null}')"
assert_eq "6d pausedUntil cleared" "$(echo "$W6D" | jq -r .pausedUntil)" "null"
assert_eq "6d cap restored (override 5, warmup off)" "$(echo "$W6D" | jq -r .cap)" "5"

assert_eq "6e warmup_started_at untouched by writes" "$(started_null)" "f"

assert_eq "6f empty patch → 400" "$(put_warmup_status '{}')" "400"
assert_eq "6f negative override → 400" "$(put_warmup_status '{"dailyCapOverride":-1}')" "400"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
