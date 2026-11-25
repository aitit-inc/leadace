#!/usr/bin/env bash
# Regression for the read-only MCP connection: a grant the person authorized
# for reading only must not write, whichever tool or client presents its token.
# An unattended agent that reads what recipients wrote is given this connection
# so a prompt injected into that text finds no tool that sends or deletes.
#
# Covers, against the local stack (localhost:8787 API, localhost:8788 MCP):
#
#   1. API: a read-only token reads (GET → 200) and every write is refused
#      (POST / PUT / DELETE → 403). A token that may write is unchanged, and a
#      `scope` claim on a browser token changes nothing.
#   2. MCP tool list: a read-only token sees the read tools and no write tool at
#      /mcp; any token sees only the read tools at /mcp/read; a token that may
#      write still sees the write tools at /mcp. Calling a write tool on a
#      read-only connection fails as an unknown tool.
#   3. Discovery: an unauthenticated call to /mcp/read is challenged with the
#      read endpoint's own metadata and scope.
#   4. OAuth: an authorization that names /mcp/read as its resource is shown as
#      read-only, yields a read-only token, and stays read-only across a
#      refresh; the session list says so. One that names nothing may write.
#
# Curl-only, no Claude session. Cleans up (revokes the session it created).
#
# Usage:
#   ./e2e/regression-read-only.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
MCP_URL="${MCP_URL:-http://localhost:8788}"

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

BODY_FILE="$(mktemp)"
api_as() { # token method path [body] → HTTP status; response body in $BODY_FILE
  local token="$1" method="$2" path="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
      -d "$body" "$API_URL$path"
  else
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" "$API_URL$path"
  fi
}
api_body() { cat "$BODY_FILE"; }

rpc() { # token endpoint-path method [params-json] → JSON-RPC response on stdout
  local token="$1" path="$2" method="$3" params="${4:-{\}}"
  curl -sS -X POST "$MCP_URL$path" \
    -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d "$(jq -nc --arg m "$method" --argjson p "$params" '{jsonrpc:"2.0",id:1,method:$m,params:$p}')"
}
lists_tool() { # token endpoint-path tool → yes | no | error (no tool list came back)
  rpc "$1" "$2" tools/list | jq -r --arg t "$3" \
    'if (.result.tools | type) != "array" then "error" elif any(.result.tools[]; .name == $t) then "yes" else "no" end'
}

command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "need openssl on PATH" >&2; exit 1; }

TOKEN_UI="$("$REPO_ROOT/e2e/mint-jwt.sh")"
TOKEN_UI_SCOPED="$("$REPO_ROOT/e2e/mint-jwt.sh" --scope read)"
TOKEN_MCP="$("$REPO_ROOT/e2e/mint-jwt.sh" --aud mcp)"
TOKEN_READ="$("$REPO_ROOT/e2e/mint-jwt.sh" --aud mcp --scope read)"
[[ -n "$TOKEN_UI" && -n "$TOKEN_UI_SCOPED" && -n "$TOKEN_MCP" && -n "$TOKEN_READ" ]] || { echo "failed to mint JWTs" >&2; exit 1; }

PROJECT_ID=""
FAMILY_ID=""
cleanup_and_exit() {
  local rc=$?
  if [[ -n "$PROJECT_ID" ]]; then
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN_UI" "$API_URL/api/projects/$PROJECT_ID" || true
  fi
  if [[ -n "$FAMILY_ID" ]]; then
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN_UI" "$MCP_URL/sessions/$FAMILY_ID" || true
  fi
  rm -f "$BODY_FILE"
  exit "$rc"
}
trap cleanup_and_exit EXIT

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
curl -sS -o /dev/null "$MCP_URL/.well-known/oauth-protected-resource" || { echo "MCP worker not reachable at $MCP_URL" >&2; exit 1; }
say "API and MCP worker reachable"

step "1. API: a read-only token reads and never writes"
assert_eq "read-only GET /projects → 200" "$(api_as "$TOKEN_READ" GET /api/projects)" "200"
PROBE_NAME="e2e-read-only-$(date +%s)"
STATUS="$(api_as "$TOKEN_READ" POST /api/projects "$(jq -nc --arg n "$PROBE_NAME" '{name:$n}')")"
assert_eq "read-only POST /projects → 403" "$STATUS" "403"
assert_eq "…and says why" "$(api_body | jq -r .error)" "This connection is read-only"
assert_eq "read-only PUT /tenant-settings → 403" "$(api_as "$TOKEN_READ" PUT /api/tenant-settings '{}')" "403"
assert_eq "read-only DELETE /projects/x → 403" "$(api_as "$TOKEN_READ" DELETE /api/projects/no-such-project)" "403"
api_as "$TOKEN_UI" GET /api/projects > /dev/null
assert_eq "the refused POST created nothing" "$(api_body | jq --arg n "$PROBE_NAME" '[.. | objects | select(.name? == $n)] | length')" "0"
assert_eq "a browser token carrying scope=read still writes" "$(api_as "$TOKEN_UI_SCOPED" PUT /api/tenant-settings '{}')" "200"
STATUS="$(api_as "$TOKEN_MCP" POST /api/projects "$(jq -nc --arg n "$PROBE_NAME" '{name:$n}')")"
assert_eq "an MCP token that may write: POST /projects → 201" "$STATUS" "201"
PROJECT_ID="$(api_body | jq -r '.id // empty')"

step "2. MCP: which tools a connection is given"
assert_eq "read-only token at /mcp lists list_projects"            "$(lists_tool "$TOKEN_READ" /mcp list_projects)" "yes"
assert_eq "read-only token at /mcp lists no send_email_and_record" "$(lists_tool "$TOKEN_READ" /mcp send_email_and_record)" "no"
assert_eq "read-only token at /mcp lists no delete_project"        "$(lists_tool "$TOKEN_READ" /mcp delete_project)" "no"
assert_eq "writing token at /mcp/read lists list_projects"            "$(lists_tool "$TOKEN_MCP" /mcp/read list_projects)" "yes"
assert_eq "writing token at /mcp/read lists no send_email_and_record" "$(lists_tool "$TOKEN_MCP" /mcp/read send_email_and_record)" "no"
assert_eq "writing token at /mcp/read/ lists no send_email_and_record" "$(lists_tool "$TOKEN_MCP" /mcp/read/ send_email_and_record)" "no"
assert_eq "writing token at /mcp still lists send_email_and_record"   "$(lists_tool "$TOKEN_MCP" /mcp send_email_and_record)" "yes"
assert_eq "a refused request is not taken for an empty tool list"     "$(lists_tool "not-a-token" /mcp send_email_and_record)" "error"
CALL="$(rpc "$TOKEN_READ" /mcp tools/call '{"name":"list_projects","arguments":{}}')"
assert_eq "read-only call of a read tool succeeds" "$(echo "$CALL" | jq -r '(.error // null) == null and (.result.isError // false) == false')" "true"
CALL="$(rpc "$TOKEN_READ" /mcp tools/call "$(jq -nc --arg id "$PROJECT_ID" '{name:"delete_project",arguments:{projectId:$id}}')")"
assert_eq "read-only call of a write tool is an unknown tool" \
  "$(echo "$CALL" | jq -r '[.error.message?, .result.content[0].text?] | map(select(. != null)) | join(" ") | test("not found"; "i")')" "true"
assert_eq "…and the project is still there" "$(api_as "$TOKEN_UI" GET "/api/projects/$PROJECT_ID/settings")" "200"

step "3. discovery: /mcp/read names its own metadata and scope"
CHALLENGE="$(curl -sS -o /dev/null -D - -X POST "$MCP_URL/mcp/read" -H 'Content-Type: application/json' -d '{}' | tr -d '\r' | grep -i '^www-authenticate:' || true)"
assert_eq "401 challenge points at the read endpoint's metadata" \
  "$([[ "$CHALLENGE" == *"/.well-known/oauth-protected-resource/mcp/read\""* ]] && echo yes || echo no)" "yes"
assert_eq "401 challenge names scope=read" "$([[ "$CHALLENGE" == *'scope="read"'* ]] && echo yes || echo no)" "yes"
META="$(curl -sS "$MCP_URL/.well-known/oauth-protected-resource/mcp/read")"
assert_eq "metadata resource is the read endpoint" "$(echo "$META" | jq -r .resource)" "$MCP_URL/mcp/read"
assert_eq "metadata offers the read scope only" "$(echo "$META" | jq -c .scopes_supported)" '["read"]'
assert_eq "the main endpoint's metadata is unchanged" "$(curl -sS "$MCP_URL/.well-known/oauth-protected-resource" | jq -r .resource)" "$MCP_URL"

step "4. OAuth: a grant for /mcp/read is read-only, and stays so"
REDIRECT="http://127.0.0.1:9/callback"
CLIENT_ID="$(curl -sS -X POST "$MCP_URL/register" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg r "$REDIRECT" '{redirect_uris:[$r],client_name:"e2e read-only"}')" | jq -r .client_id)"
[[ -n "$CLIENT_ID" && "$CLIENT_ID" != "null" ]] || { echo "client registration failed" >&2; exit 1; }
VERIFIER="$(openssl rand -hex 32)"
CHALLENGE_S256="$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')"

authorize_session() { # extra query → the consent session id
  curl -sS -o /dev/null -D - -G "$MCP_URL/authorize" \
    --data-urlencode "client_id=$CLIENT_ID" --data-urlencode "redirect_uri=$REDIRECT" \
    --data-urlencode "code_challenge=$CHALLENGE_S256" --data-urlencode "code_challenge_method=S256" \
    --data-urlencode "response_type=code" "$@" \
    | tr -d '\r' | sed -n 's/^[Ll]ocation: .*[?&]session=\([0-9a-f]*\).*/\1/p'
}
session_read_only() { curl -sS "$MCP_URL/authorize/session?session=$1" | jq -r .readOnly; }

SESSION_PLAIN="$(authorize_session)"
assert_eq "an authorization that names nothing may write" "$(session_read_only "$SESSION_PLAIN")" "false"
SESSION_SCOPE="$(authorize_session --data-urlencode "scope=read")"
assert_eq "scope=read is read-only" "$(session_read_only "$SESSION_SCOPE")" "true"
SESSION="$(authorize_session --data-urlencode "resource=$MCP_URL/mcp/read")"
assert_eq "resource=/mcp/read is read-only" "$(session_read_only "$SESSION")" "true"

CODE="$(curl -sS -X POST "$MCP_URL/authorize/finalize" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg s "$SESSION" --arg t "$TOKEN_UI" '{session:$s,access_token:$t}')" \
  | jq -r .redirect | sed -n 's/.*[?&]code=\([0-9a-f]*\).*/\1/p')"
[[ -n "$CODE" ]] || { echo "authorization was not finalized" >&2; exit 1; }
GRANT="$(curl -sS -X POST "$MCP_URL/token" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg c "$CODE" --arg v "$VERIFIER" --arg r "$REDIRECT" \
        '{grant_type:"authorization_code",code:$c,code_verifier:$v,redirect_uri:$r}')")"
ACCESS="$(echo "$GRANT" | jq -r .access_token)"
assert_eq "the token response names scope=read" "$(echo "$GRANT" | jq -r .scope)" "read"
assert_eq "granted token: GET → 200" "$(api_as "$ACCESS" GET /api/projects)" "200"
assert_eq "granted token: PUT → 403" "$(api_as "$ACCESS" PUT /api/tenant-settings '{}')" "403"
assert_eq "granted token at /mcp lists no send_email_and_record" "$(lists_tool "$ACCESS" /mcp send_email_and_record)" "no"

SESSIONS="$(curl -sS -H "Authorization: Bearer $TOKEN_UI" "$MCP_URL/sessions")"
FAMILY_ID="$(echo "$SESSIONS" | jq -r '[.sessions[] | select(.clientName == "e2e read-only")] | last | .familyId // empty')"
assert_eq "the session list shows it as read-only" \
  "$(echo "$SESSIONS" | jq -r --arg f "$FAMILY_ID" '.sessions[] | select(.familyId == $f) | .readOnly')" "true"

REFRESHED="$(curl -sS -X POST "$MCP_URL/token" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg t "$(echo "$GRANT" | jq -r .refresh_token)" '{grant_type:"refresh_token",refresh_token:$t}')")"
ACCESS2="$(echo "$REFRESHED" | jq -r .access_token)"
assert_eq "after a refresh the response still names scope=read" "$(echo "$REFRESHED" | jq -r .scope)" "read"
assert_eq "after a refresh: GET → 200" "$(api_as "$ACCESS2" GET /api/projects)" "200"
assert_eq "after a refresh: PUT → 403" "$(api_as "$ACCESS2" PUT /api/tenant-settings '{}')" "403"

printf '\n=== summary: %d passed, %d failed ===\n' "$PASS" "$FAIL" >&2
[[ "$FAIL" -eq 0 ]] || exit 2
