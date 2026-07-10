#!/usr/bin/env bash
# Regression for the PR #224 bounce-rate signals: eval stats must not count
# bounces as replies, and both bounce-rate readouts must use the threadable
# denominator (channel='email' AND message_id IS NOT NULL). If either filter
# regresses, a bounce-only dead source looks like a high-reply source and the
# per-strategy discovery loop optimizes on corrupted input.
#
# Covers, against the local stack (localhost:8787 API + 54322 Postgres):
#
#   Seed: 4 US prospects registered under one discoveryStrategy slug, 4
#   'sent' email logs on a dedicated dummy sending identity assigned to the
#   project. L1/L2 get a message_id (threadable); L3/L4 stay unthreaded.
#   Responses: L1 bounce, L3 bounce (unthreaded), L4 reply.
#
#   1. GET /projects/:id/stats → discoveryStrategyResponseRate slug bucket:
#      total=4, responses=1 (bounces are NOT replies), rate=25,
#      bounces=1 (L3's unthreaded bounce excluded), bounceRate=50 (1/2
#      threadable — not 1/4 of all sends).
#   2. Same response → freshSignalResponseRate.withoutSignal counts the
#      bounces out of `responses` too (total=4, responses=1).
#   3. GET /projects/:id/mailbox-health → per-identity trailing-30d fields:
#      bounceWindowDays=30, sentInWindow=2 (threadable only), bounced=1,
#      bounceRate=50.
#
# The dedicated identity keeps the identity-scoped (tenant-wide) mailbox
# counters deterministic on a dirty local DB. Curl-only, no Claude session.
# Cleans up.
#
# Usage:
#   ./e2e/regression-bounce-stats.sh
#   SKIP_CLEANUP=1 ./e2e/regression-bounce-stats.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-bounce-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
SLUG="e2e-bounce-probe"

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

mkseed() {
  local tag="$1"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" --arg s "$SLUG" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:"US", countrySource:"manual", discoveryStrategy:$s,
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}'
}

send_email() { # prospectId → outreach_log id
  api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"e2e", body:"seed", status:"sent"}')" \
    | jq -r '.id // ""'
}

record_response() { # outreachLogId responseType
  api POST /api/responses "$(jq -nc --argjson lid "$1" --arg rt "$2" \
    '{outreachLogId:$lid, channel:"email", content:("e2e "+$rt), sentiment:"neutral", responseType:$rt}')" >/dev/null
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

ORIGINAL_TENANT="$(api GET /api/tenant-settings)"
ORIG_LEGAL="$(echo "$ORIGINAL_TENANT" | jq -r '.legalName // ""')"
ORIG_ADDR="$(echo "$ORIGINAL_TENANT" | jq -r '.physicalAddress // ""')"
ORIG_COUNTRY="$(echo "$ORIGINAL_TENANT" | jq -r '.defaultSenderCountry // ""')"

# Dedicated dummy identity: mailbox-health counts are identity-scoped across
# the tenant, so an exclusive identity keeps them deterministic even when the
# local DB carries real sends on the fallback Gmail row. smtp_imap, because
# gmail_oauth is unique per (tenant, user) and the row may already exist. The
# secret must be a real pgp-encrypted smtp payload — listSendingIdentities
# decrypts smtp_imap secrets, so a raw-byte dummy would 500 that endpoint if
# the row lingers (SKIP_CLEANUP=1 / failed teardown).
ENC_KEY="$(grep -E '^GMAIL_TOKEN_ENCRYPTION_KEY=' "$REPO_ROOT/backend/.dev.vars" | head -1 | cut -d= -f2- | tr -d '"')"
[[ -n "$ENC_KEY" ]] || { echo "could not read GMAIL_TOKEN_ENCRYPTION_KEY from backend/.dev.vars" >&2; exit 1; }
SECRET_PAYLOAD="$(jq -nc --arg e "$RUN_TAG@example.com" \
  '{smtpHost:"smtp.example.com", smtpPort:465, imapHost:"imap.example.com", imapPort:993, username:$e, appPassword:"e2e-dummy"}')"
IDENTITY_ID="$(psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret)
  VALUES ('$TENANT_ID', replace(gen_random_uuid()::text,'-',''), '$USER_ID', 'smtp_imap', '$RUN_TAG@example.com', NULL, pgp_sym_encrypt('$SECRET_PAYLOAD'::text, '$ENC_KEY'))
  RETURNING identity_id;" | head -1)"
[[ -n "$IDENTITY_ID" ]] || { echo "failed to insert dummy sending identity" >&2; exit 1; }
say "dummy identity_id=$IDENTITY_ID"

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>}, identity $IDENTITY_ID, and run rows as-is." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  local restore_body
  restore_body="$(jq -nc --arg legal "$ORIG_LEGAL" --arg addr "$ORIG_ADDR" --arg country "$ORIG_COUNTRY" \
    '{legalName: (if $legal=="" then null else $legal end),
      physicalAddress: (if $addr=="" then null else $addr end),
      defaultSenderCountry: (if $country=="" then null else $country end)}')"
  api PUT /api/tenant-settings "$restore_body" > /dev/null || true
  say "restored tenant settings"
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID (outreach_logs cascade)"
  fi
  psql_local "DELETE FROM sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id='$IDENTITY_ID';" > /dev/null || true
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped run-tagged rows"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance ready + project on the dummy identity + 4 seeds"
api PUT /api/tenant-settings '{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
say "tenant compliance set"

PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_id=$PROJECT_ID"

ASSIGN_RESP="$(api PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg i "$IDENTITY_ID" '{sendingIdentityId:$i}')")"
assert_eq "project assigned to dummy identity" "$(echo "$ASSIGN_RESP" | jq -r '.sendingIdentityId // ""')" "$IDENTITY_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed a)" --argjson b "$(mkseed b)" --argjson c "$(mkseed c)" --argjson d "$(mkseed d)" \
  '{projectId:$pid, prospects:[$a,$b,$c,$d]}')"
assert_eq "seed inserted=4" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "4"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_A="$(pid_of a)"; P_B="$(pid_of b)"; P_C="$(pid_of c)"; P_D="$(pid_of d)"
[[ -n "$P_A" && -n "$P_B" && -n "$P_C" && -n "$P_D" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }

step "seed sends: L1/L2 threadable (message_id), L3/L4 unthreaded"
L1="$(send_email "$P_A")"; L2="$(send_email "$P_B")"; L3="$(send_email "$P_C")"; L4="$(send_email "$P_D")"
[[ -n "$L1" && -n "$L2" && -n "$L3" && -n "$L4" ]] || { echo "send seeding failed: L1=$L1 L2=$L2 L3=$L3 L4=$L4" >&2; exit 1; }
# POST /api/outreach never sets message_id (only real sends do), so patch the
# threadable flag directly — same precedent as the warmup script's column pokes.
psql_local "UPDATE outreach_logs SET message_id='<$RUN_TAG-'||id||'@example.com>' WHERE id IN ($L1,$L2);" > /dev/null
say "logs: threadable=$L1,$L2 unthreaded=$L3,$L4"

step "seed responses: bounce on L1 (threaded), bounce on L3 (unthreaded), reply on L4"
record_response "$L1" bounce
record_response "$L3" bounce
record_response "$L4" reply

step "Test 1: discoveryStrategyResponseRate bucket for $SLUG"
STATS="$(api GET "/api/projects/$PROJECT_ID/stats")"
BUCKET="$(echo "$STATS" | jq -c --arg s "$SLUG" '.metrics.discoveryStrategyResponseRate[]? | select(.strategy == $s) // empty')"
assert_eq "slug bucket present" "$([[ -n "$BUCKET" ]] && echo present || echo missing)" "present"
assert_eq "total=4"        "$(echo "$BUCKET" | jq -r '.total')" "4"
assert_eq "responses=1 (bounces are not replies)" "$(echo "$BUCKET" | jq -r '.responses')" "1"
assert_eq "rate=25"        "$(echo "$BUCKET" | jq -r '.rate')" "25"
assert_eq "bounces=1 (unthreaded bounce excluded)" "$(echo "$BUCKET" | jq -r '.bounces')" "1"
assert_eq "bounceRate=50 (threadable denominator)" "$(echo "$BUCKET" | jq -r '.bounceRate')" "50"

step "Test 2: freshSignalResponseRate excludes bounces from responses"
assert_eq "withoutSignal.total=4"     "$(echo "$STATS" | jq -r '.metrics.freshSignalResponseRate.withoutSignal.total')" "4"
assert_eq "withoutSignal.responses=1" "$(echo "$STATS" | jq -r '.metrics.freshSignalResponseRate.withoutSignal.responses')" "1"

step "Test 3: mailbox-health per-identity trailing-30d bounce fields"
MH="$(api GET "/api/projects/$PROJECT_ID/mailbox-health")"
assert_eq "bounceWindowDays=30" "$(echo "$MH" | jq -r '.bounceWindowDays')" "30"
assert_eq "sentInWindow=2 (threadable only)" "$(echo "$MH" | jq -r '.sentInWindow')" "2"
assert_eq "bounced=1" "$(echo "$MH" | jq -r '.bounced')" "1"
assert_eq "bounceRate=50" "$(echo "$MH" | jq -r '.bounceRate')" "50"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
