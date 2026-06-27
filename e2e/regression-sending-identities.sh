#!/usr/bin/env bash
# Regression for the sending-identity registry (G3 P1):
#   services/sending-identity.ts (register/list/delete) + routes/sending-identities.ts
#   + schema (sending_identities constraints, project_settings.sending_identity_id FK).
#
# Sending now happens server-side over 465 implicit-TLS (services/smtp-send), and
# registration VERIFIES the mailbox by connecting before storing. A real
# successful register/send therefore needs a reachable mailbox with valid creds
# (manual, against a real cold mailbox) — so this suite covers everything that
# does NOT require a working external mailbox:
#
#   1. Register validation rejects an unverifiable mailbox → 422 (the verify
#      connect fails: 127.0.0.1 over TLS is blocked from the Worker).
#   2. List returns the read-only SMTP connection view (host/port/username) and
#      NEVER the app password / secret.
#   3. DB shape: provider='smtp_imap', scope IS NULL, secret decrypts to the exact
#      JSON connection payload (pgp_sym_encrypt round-trip).
#   4. Duplicate From address → 409 (checked before the verify).
#   5. A project pointing at the identity blocks delete → 409, then unset → 200.
#   6. gmail_oauth is not deletable via this registry (→ 404); unknown id → 404.
#
# Test identities are SQL-inserted (the API register would connect-verify, which a
# fake mailbox can't pass). The pure plan gate/cap is unit-tested.
#
# Curl-only, no Claude session / Anthropic budget. Single tenant, one project,
# one identity, cleans up after itself.
#
# Usage:
#   ./e2e/regression-sending-identities.sh
#   SKIP_CLEANUP=1 ./e2e/regression-sending-identities.sh
#
# Exit status: 0 all passed · 1 setup/HTTP failure · 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-si-$(date +%s)"
SMTP_EMAIL="cold@$RUN_TAG.example"
APP_PASSWORD="app-pw-$RUN_TAG"
PROJECT_NAME="$RUN_TAG project"
IDENTITY_ID="e2esi$(date +%s)$$"

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
api_status() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o /dev/null -w '%{http_code}' -X "$method" -H "Authorization: Bearer $TOKEN" "$API_URL$path"
  fi
}

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

# Register body for the validation-reject test: a host the Worker can't reach over
# TLS, so verifySmtpCredentials fails and the register is refused.
unreachable_body() { # fromEmail
  jq -nc --arg e "$1" --arg pw "$APP_PASSWORD" \
    '{fromEmail:$e, smtpHost:"127.0.0.1", smtpPort:465, imapHost:"127.0.0.1", imapPort:993, username:$e, appPassword:$pw}'
}
# SQL-insert an smtp_imap identity (port 465), bypassing the connect-verify the API
# register does — there is no reachable mailbox in CI.
insert_identity() { # identityId fromEmail
  local payload
  payload="$(jq -nc --arg e "$2" --arg pw "$APP_PASSWORD" \
    '{smtpHost:"smtp.zoho.com", smtpPort:465, imapHost:"imap.zoho.com", imapPort:993, username:$e, appPassword:$pw}')"
  psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret, granted_at, updated_at) VALUES ('$TENANT_ID', '$1', '$USER_ID', 'smtp_imap', '$2', NULL, pgp_sym_encrypt('$payload'::text, '$ENC_KEY'), now(), now());" >/dev/null
}
list_for() { api GET /api/me/sending-identities | jq -c --arg e "$1" '.identities[]? | select(.fromEmail==$e)'; }

require_jq
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }
ENC_KEY="$(grep -E '^GMAIL_TOKEN_ENCRYPTION_KEY=' "$REPO_ROOT/backend/.dev.vars" | head -1 | cut -d= -f2- | tr -d '"')"
[[ -n "$ENC_KEY" ]] || { echo "could not read GMAIL_TOKEN_ENCRYPTION_KEY from backend/.dev.vars" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

USER_ID="$(psql_local "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;")"
TENANT_ID="$(psql_local "SELECT tenant_id FROM tenant_members WHERE user_id = '$USER_ID' LIMIT 1;")"
[[ -n "$TENANT_ID" ]] || { echo "no tenant for user $USER_ID — sign in once via the frontend first" >&2; exit 1; }
say "tenant_id=$TENANT_ID"

PROJECT_ID=""
restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving test rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  psql_local "UPDATE project_settings SET sending_identity_id=NULL WHERE tenant_id='$TENANT_ID' AND sending_identity_id IN (SELECT identity_id FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$SMTP_EMAIL');" >/dev/null 2>&1 || true
  psql_local "DELETE FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$SMTP_EMAIL';" >/dev/null 2>&1 || true
  if [[ -n "$PROJECT_ID" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" >/dev/null 2>&1 || true
    say "deleted project $PROJECT_ID"
  fi
  say "dropped test sending identities tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "1. register validation rejects an unverifiable mailbox → 422"
REJECT="$(api POST /api/me/sending-identities "$(unreachable_body "reject@$RUN_TAG.example")")"
assert_eq "unverifiable mailbox → 422" "$(api_status POST /api/me/sending-identities "$(unreachable_body "reject2@$RUN_TAG.example")")" "422"
assert_eq "error names the connection problem" "$(echo "$REJECT" | jq -r '.error' | grep -qi 'connect to the SMTP mailbox' && echo y || echo n)" "y"
assert_eq "nothing stored for the rejected mailbox" "$(psql_local "SELECT EXISTS(SELECT 1 FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email LIKE 'reject%@$RUN_TAG.example');")" "f"

step "2. list returns the read-only SMTP connection view, never the secret"
insert_identity "$IDENTITY_ID" "$SMTP_EMAIL"
LISTED="$(list_for "$SMTP_EMAIL")"
assert_eq "list contains the identity" "$(echo "$LISTED" | jq -r '.provider')" "smtp_imap"
assert_eq "list dailyCapOverride defaults null (follows the warmup ramp)" "$(echo "$LISTED" | jq -r '.dailyCapOverride')" "null"
assert_eq "list exposes smtp.smtpHost" "$(echo "$LISTED" | jq -r '.smtp.smtpHost')" "smtp.zoho.com"
assert_eq "list exposes smtp.smtpPort (number)" "$(echo "$LISTED" | jq -r '.smtp.smtpPort')" "465"
assert_eq "list exposes smtp.username" "$(echo "$LISTED" | jq -r '.smtp.username')" "$SMTP_EMAIL"
assert_eq "smtp view does NOT carry appPassword" "$(echo "$LISTED" | jq -r '.smtp | has("appPassword")')" "false"
assert_eq "list does NOT leak appPassword" "$(echo "$LISTED" | jq -r 'has("appPassword")')" "false"
assert_eq "list does NOT leak secret" "$(echo "$LISTED" | jq -r 'has("secret")')" "false"

step "3. DB shape: smtp provider, scope NULL, secret decrypts to the exact payload"
assert_eq "db scope IS NULL" "$(psql_local "SELECT (scope IS NULL) FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$SMTP_EMAIL';")" "t"
DECRYPTED="$(psql_local "SELECT pgp_sym_decrypt(secret, '$ENC_KEY')::text FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$SMTP_EMAIL';")"
assert_eq "secret decrypts to the app password" "$(echo "$DECRYPTED" | jq -r '.appPassword')" "$APP_PASSWORD"
assert_eq "secret carries smtpPort as a number" "$(echo "$DECRYPTED" | jq -r '.smtpPort')" "465"

step "4. duplicate From address → 409 (before the verify)"
assert_eq "register same fromEmail → 409" "$(api_status POST /api/me/sending-identities "$(unreachable_body "$SMTP_EMAIL")")" "409"

step "5. assign identity to a project, then delete-conflict + unset"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
assert_eq "PUT settings with unknown identity → 400" "$(api_status PUT "/api/projects/$PROJECT_ID/settings" '{"sendingIdentityId":"bogus-does-not-exist"}')" "400"
assert_eq "PUT settings sendingIdentityId → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg id "$IDENTITY_ID" '{sendingIdentityId:$id}')")" "200"
assert_eq "GET settings echoes sendingIdentityId" "$(api GET "/api/projects/$PROJECT_ID/settings" | jq -r '.sendingIdentityId')" "$IDENTITY_ID"
assert_eq "delete blocked while a project references it → 409" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "409"
assert_eq "PUT settings sendingIdentityId=null → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/settings" '{"sendingIdentityId":null}')" "200"
assert_eq "GET settings sendingIdentityId now null" "$(api GET "/api/projects/$PROJECT_ID/settings" | jq -r '.sendingIdentityId')" "null"
assert_eq "delete succeeds after unset → 200" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "200"
assert_eq "list no longer contains it" "$([[ -z "$(list_for "$SMTP_EMAIL")" ]] && echo gone || echo present)" "gone"

step "6. gmail_oauth not deletable; unknown id → 404"
GMAIL_ID="$(psql_local "SELECT identity_id FROM sending_identities WHERE tenant_id='$TENANT_ID' AND provider='gmail_oauth' LIMIT 1;")"
if [[ -n "$GMAIL_ID" ]]; then
  assert_eq "delete gmail identity via registry → 404" "$(api_status DELETE "/api/me/sending-identities/$GMAIL_ID")" "404"
  assert_eq "gmail row still present after the attempt" "$(psql_local "SELECT EXISTS(SELECT 1 FROM sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id='$GMAIL_ID');")" "t"
else
  say "no gmail_oauth identity for this tenant — skipping the not-deletable check"
fi
assert_eq "delete already-deleted id → 404" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "404"
assert_eq "delete bogus id → 404" "$(api_status DELETE "/api/me/sending-identities/does-not-exist-xyz")" "404"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
[[ "$FAIL" -gt 0 ]] && exit 2
exit 0
