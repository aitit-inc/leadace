#!/usr/bin/env bash
# Regression for the sending-identity registry:
#   services/sending-identity.ts (register/list/delete) + routes/sending-identities.ts
#   + schema (sending_identities constraints, project_sending_identities FK).
#
# Sending happens server-side over 465 implicit-TLS (services/smtp-send), and
# registration VERIFIES the mailbox by connecting before storing. A real
# register/send therefore needs a reachable mailbox with valid creds (manual,
# against a real cold mailbox), so this suite covers only what does NOT require
# one. The pure plan gate/cap is unit-tested.
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
ALIAS_EMAIL="sales@$RUN_TAG.example"
GOOGLE_EMAIL="second@$RUN_TAG.example"
GOOGLE_ALIAS_EMAIL="hello@$RUN_TAG.example"
GOOGLE_ID="e2esg$(date +%s)$$"
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
    '{smtpHost:"smtp.gmail.com", smtpPort:465, imapHost:"imap.gmail.com", imapPort:993, username:$e, appPassword:$pw}')"
  psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, scope, secret, granted_at, updated_at) VALUES ('$TENANT_ID', '$1', '$USER_ID', 'smtp_imap', '$2', NULL, pgp_sym_encrypt('$payload'::text, '$ENC_KEY'), now(), now());" >/dev/null
}
# SQL-insert a Google account connected from Account settings (sign_in_account =
# false), bypassing the Google consent the API register needs.
insert_google_identity() { # identityId fromEmail
  psql_local "INSERT INTO sending_identities (tenant_id, identity_id, user_id, provider, from_email, sign_in_account, scope, secret, granted_at, updated_at) VALUES ('$TENANT_ID', '$1', '$USER_ID', 'gmail_oauth', '$2', false, 'https://www.googleapis.com/auth/gmail.send', pgp_sym_encrypt('refresh-token-$RUN_TAG'::text, '$ENC_KEY'), now(), now());" >/dev/null
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
  psql_local "DELETE FROM project_sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id IN (SELECT identity_id FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$SMTP_EMAIL');" >/dev/null 2>&1 || true
  psql_local "DELETE FROM project_sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id IN (SELECT identity_id FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email IN ('$GOOGLE_EMAIL', '$GOOGLE_ALIAS_EMAIL'));" >/dev/null 2>&1 || true
  psql_local "DELETE FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email IN ('$SMTP_EMAIL', '$ALIAS_EMAIL', '$GOOGLE_ALIAS_EMAIL', '$GOOGLE_EMAIL');" >/dev/null 2>&1 || true
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
assert_eq "list exposes smtp.smtpHost" "$(echo "$LISTED" | jq -r '.smtp.smtpHost')" "smtp.gmail.com"
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

step "5. list the identity as a project mailbox, then delete-conflict + unset"
PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
assert_eq "PUT mailboxes with unknown identity → 400" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" '{"identityIds":["bogus-does-not-exist"]}')" "400"
assert_eq "PUT mailboxes with a repeated identity → 400" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" "$(jq -nc --arg id "$IDENTITY_ID" '{identityIds:[$id,$id]}')")" "400"
assert_eq "PUT mailboxes [identity] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" "$(jq -nc --arg id "$IDENTITY_ID" '{identityIds:[$id]}')")" "200"
assert_eq "GET settings echoes sendingIdentityIds" "$(api GET "/api/projects/$PROJECT_ID/settings" | jq -r '.sendingIdentityIds | join(",")')" "$IDENTITY_ID"
assert_eq "mailbox-health lists it first" "$(api GET "/api/projects/$PROJECT_ID/mailbox-health" | jq -r '.mailboxes[0].fromEmail')" "$SMTP_EMAIL"
assert_eq "list names the project on the mailbox; SMTP never reports revokedSince" "$(list_for "$SMTP_EMAIL" | jq -r '"\(.projects | join(",")) \(.revokedSince)"')" "$PROJECT_NAME null"
assert_eq "delete blocked while a project lists it → 409" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "409"
assert_eq "PUT mailboxes [] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" '{"identityIds":[]}')" "200"
assert_eq "GET settings sendingIdentityIds now empty" "$(api GET "/api/projects/$PROJECT_ID/settings" | jq -r '.sendingIdentityIds | length')" "0"
assert_eq "delete succeeds after unset → 200" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "200"
assert_eq "list no longer contains it" "$([[ -z "$(list_for "$SMTP_EMAIL")" ]] && echo gone || echo present)" "gone"

step "6. the sign-in Gmail is not deletable; unknown id → 404"
GMAIL_ID="$(psql_local "SELECT identity_id FROM sending_identities WHERE tenant_id='$TENANT_ID' AND sign_in_account LIMIT 1;")"
if [[ -n "$GMAIL_ID" ]]; then
  assert_eq "list flags the sign-in Gmail" "$(api GET /api/me/sending-identities | jq -r --arg id "$GMAIL_ID" '.identities[] | select(.identityId==$id) | .signInAccount')" "true"
  assert_eq "a project listing no mailbox counts as the sign-in Gmail's" "$(api GET /api/me/sending-identities | jq -r --arg id "$GMAIL_ID" --arg n "$PROJECT_NAME" '.identities[] | select(.identityId==$id) | .projects | any(. == $n)')" "true"
  assert_eq "delete sign-in gmail via registry → 404" "$(api_status DELETE "/api/me/sending-identities/$GMAIL_ID")" "404"
  assert_eq "gmail row still present after the attempt" "$(psql_local "SELECT EXISTS(SELECT 1 FROM sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id='$GMAIL_ID');")" "t"
else
  say "no sign-in Gmail for this tenant — skipping the not-deletable check"
fi
assert_eq "delete already-deleted id → 404" "$(api_status DELETE "/api/me/sending-identities/$IDENTITY_ID")" "404"
assert_eq "delete bogus id → 404" "$(api_status DELETE "/api/me/sending-identities/does-not-exist-xyz")" "404"

step "7. a Gmail Send-As alias is a mailbox of its own under a connected Gmail"
ALIAS_BODY="$(jq -nc --arg e "$ALIAS_EMAIL" --arg p "${GMAIL_ID:-missing}" '{fromEmail:$e, parentIdentityId:$p}')"
if [[ -n "$GMAIL_ID" ]]; then
  ALIAS="$(api POST /api/me/sending-identities/gmail-aliases "$ALIAS_BODY")"
  ALIAS_ID="$(echo "$ALIAS" | jq -r '.identityId // ""')"
  assert_eq "register alias → kind gmail_alias" "$(echo "$ALIAS" | jq -r '.kind')" "gmail_alias"
  assert_eq "alias parentIdentityId = the connected Gmail" "$(echo "$ALIAS" | jq -r '.parentIdentityId')" "$GMAIL_ID"
  assert_eq "alias provider stays gmail_oauth" "$(echo "$ALIAS" | jq -r '.provider')" "gmail_oauth"
  assert_eq "db: alias secret IS NULL, scope IS NULL" "$(psql_local "SELECT (secret IS NULL AND scope IS NULL) FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email='$ALIAS_EMAIL';")" "t"
  assert_eq "register same alias again → 409" "$(api_status POST /api/me/sending-identities/gmail-aliases "$ALIAS_BODY")" "409"
  assert_eq "register the Gmail's own address as an alias → 409" "$(api_status POST /api/me/sending-identities/gmail-aliases "$(jq -nc --arg e "$(psql_local "SELECT from_email FROM sending_identities WHERE tenant_id='$TENANT_ID' AND identity_id='$GMAIL_ID';")" --arg p "$GMAIL_ID" '{fromEmail:$e, parentIdentityId:$p}')")" "409"
  assert_eq "alias under an unknown parent → 404" "$(api_status POST /api/me/sending-identities/gmail-aliases "$(jq -nc --arg e "$ALIAS_EMAIL" '{fromEmail:$e, parentIdentityId:"does-not-exist-xyz"}')")" "404"
  assert_eq "list shows the connected Gmail as kind gmail" "$(api GET /api/me/sending-identities | jq -r --arg id "$GMAIL_ID" '.identities[] | select(.identityId==$id) | .kind')" "gmail"
  assert_eq "PUT mailboxes [alias] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" "$(jq -nc --arg id "$ALIAS_ID" '{identityIds:[$id]}')")" "200"
  assert_eq "mailbox-health names the alias with its kind" "$(api GET "/api/projects/$PROJECT_ID/mailbox-health" | jq -r '.mailboxes[0] | "\(.fromEmail) \(.kind)"')" "$ALIAS_EMAIL gmail_alias"
  assert_eq "list names the project on the alias, no longer on the Gmail" "$(api GET /api/me/sending-identities | jq -r --arg a "$ALIAS_ID" --arg g "$GMAIL_ID" --arg n "$PROJECT_NAME" '[(.identities[] | select(.identityId==$a)), (.identities[] | select(.identityId==$g))] | map(.projects | any(. == $n)) | join(" ")')" "true false"
  assert_eq "delete blocked while a project lists the alias → 409" "$(api_status DELETE "/api/me/sending-identities/$ALIAS_ID")" "409"
  assert_eq "PUT mailboxes [] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" '{"identityIds":[]}')" "200"
  assert_eq "delete alias → 200" "$(api_status DELETE "/api/me/sending-identities/$ALIAS_ID")" "200"
  assert_eq "alias gone from the list" "$([[ -z "$(list_for "$ALIAS_EMAIL")" ]] && echo gone || echo present)" "gone"
else
  assert_eq "register alias without a connected Gmail → 404" "$(api_status POST /api/me/sending-identities/gmail-aliases "$ALIAS_BODY")" "404"
fi

step "8. a Google account connected from Account settings: own aliases, removable with them"
insert_google_identity "$GOOGLE_ID" "$GOOGLE_EMAIL"
GLISTED="$(list_for "$GOOGLE_EMAIL")"
assert_eq "list shows it as kind gmail, not the sign-in account" "$(echo "$GLISTED" | jq -r '"\(.kind) \(.signInAccount)"')" "gmail false"
GALIAS="$(api POST /api/me/sending-identities/gmail-aliases "$(jq -nc --arg e "$GOOGLE_ALIAS_EMAIL" --arg p "$GOOGLE_ID" '{fromEmail:$e, parentIdentityId:$p}')")"
GALIAS_ID="$(echo "$GALIAS" | jq -r '.identityId // ""')"
assert_eq "alias parentIdentityId = the connected Google account" "$(echo "$GALIAS" | jq -r '.parentIdentityId')" "$GOOGLE_ID"
assert_eq "fresh account and alias report no revokedSince" "$(api GET /api/me/sending-identities | jq -r --arg g "$GOOGLE_ID" --arg a "$GALIAS_ID" '[(.identities[] | select(.identityId==$g)), (.identities[] | select(.identityId==$a))] | map(.revokedSince == null) | join(" ")')" "true true"
psql_local "UPDATE sending_identities SET auth_revoked_at = now() WHERE tenant_id='$TENANT_ID' AND identity_id='$GOOGLE_ID';" >/dev/null
assert_eq "a revoked account reports revokedSince, and its alias reports the parent's" "$(api GET /api/me/sending-identities | jq -r --arg g "$GOOGLE_ID" --arg a "$GALIAS_ID" '[(.identities[] | select(.identityId==$g)), (.identities[] | select(.identityId==$a))] | map(.revokedSince != null) | join(" ")')" "true true"
assert_eq "PUT mailboxes [google alias] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" "$(jq -nc --arg id "$GALIAS_ID" '{identityIds:[$id]}')")" "200"
assert_eq "delete the account blocked while a project lists its alias → 409" "$(api_status DELETE "/api/me/sending-identities/$GOOGLE_ID")" "409"
assert_eq "PUT mailboxes [] → 200" "$(api_status PUT "/api/projects/$PROJECT_ID/mailboxes" '{"identityIds":[]}')" "200"
assert_eq "delete the connected Google account → 200" "$(api_status DELETE "/api/me/sending-identities/$GOOGLE_ID")" "200"
assert_eq "its alias went with it" "$(psql_local "SELECT EXISTS(SELECT 1 FROM sending_identities WHERE tenant_id='$TENANT_ID' AND from_email IN ('$GOOGLE_EMAIL', '$GOOGLE_ALIAS_EMAIL'));")" "f"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
[[ "$FAIL" -gt 0 ]] && exit 2
exit 0
