#!/usr/bin/env bash
# Regression for the agent's authority envelope: settings that bound what the
# agent may do are Web UI only, and a playbook (followed as procedure) is
# readable over MCP only once a human approved the version. The server tells
# the two callers apart by JWT audience (aud=mcp → caller 'mcp'); if either gate
# regresses, a prompt-injected or misjudging agent can rewrite its own limits
# (footer, outbound mode, sender identity) or execute a playbook nobody vetted.
#
# Covers, against the local stack (localhost:8787 API):
#
#   1. PUT /tenant-settings with an MCP token → 403 (whole endpoint); browser → 200.
#   2. A new project reads back outboundMode=draft (DB default). PUT
#      /projects/:id/settings: MCP token writing any UI-only field (outbound
#      mode, sending identity, sender identity, footer override, landing
#      CTA / media / branding) → 403 naming the field, value unchanged; MCP
#      writing an agent-owned field (inquiryOneLiner) → 200; browser writing
#      outboundMode → 200.
#   3. Playbook approval gate: MCP save → 201 pending (approvedAt null); MCP GET
#      → 412; browser GET → 200 (newest, pending); MCP approve → 403; browser
#      approve → 200; MCP GET → 200 (approved content); re-approve → 409;
#      unknown version → 404; a later MCP save stays pending and MCP GET keeps
#      serving the approved version (history over MCP lists approved versions
#      only; browser history lists all); a browser save is approved on write.
#   4. Non-playbook slugs are ungated: MCP save → 201, MCP GET → 200; approve on
#      a non-playbook slug → 400.
#   5. Slug allowlist: unknown slug → 400, malformed playbook slug → 400.
#   6. The add-means suggestion resolves on approval, not on the pending save.
#
# Curl-only, no Claude session. Cleans up (project delete cascades).
#
# Usage:
#   ./e2e/regression-caller-gates.sh
#   SKIP_CLEANUP=1 ./e2e/regression-caller-gates.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-caller-gates-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
PLAYBOOK_SLUG="e2e-means"
SUGGESTION_SLUG="e2e-means-suggested"

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
ui()  { api_as "$TOKEN_UI" "$@"; }
mcp() { api_as "$TOKEN_MCP" "$@"; }
api_body() { cat "$BODY_FILE"; }

require_jq() { command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }; }

require_jq
TOKEN_UI="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN_UI" ]] || { echo "failed to mint browser JWT" >&2; exit 1; }
TOKEN_MCP="$("$REPO_ROOT/e2e/mint-jwt.sh" --aud mcp)"
[[ -n "$TOKEN_MCP" ]] || { echo "failed to mint MCP JWT" >&2; exit 1; }

PROJECT_ID=""
cleanup_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} as-is." >&2
    exit "$rc"
  fi
  if [[ -n "$PROJECT_ID" ]]; then
    echo "" >&2; echo "=== teardown ===" >&2
    curl -sS -o /dev/null -X DELETE -H "Authorization: Bearer $TOKEN_UI" "$API_URL/api/projects/$PROJECT_ID" || true
  fi
  rm -f "$BODY_FILE"
  exit "$rc"
}
trap cleanup_and_exit EXIT

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

step "setup: create project named \"$PROJECT_NAME\""
STATUS="$(ui POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
[[ "$STATUS" == "201" ]] || { echo "project create failed ($STATUS): $(api_body)" >&2; exit 1; }
PROJECT_ID="$(api_body | jq -r .id)"
say "project_id=$PROJECT_ID"
DOCS="/api/projects/$PROJECT_ID/documents"

step "1. tenant settings are Web UI only"
STATUS="$(mcp PUT /api/tenant-settings '{"legalName":"E2E Probe Inc."}')"
assert_eq "MCP PUT → 403" "$STATUS" "403"
STATUS="$(mcp PUT /api/tenant-settings '{}')"
assert_eq "MCP empty PUT → 403 (whole endpoint)" "$STATUS" "403"
STATUS="$(ui PUT /api/tenant-settings '{}')"
assert_eq "browser empty PUT → 200" "$STATUS" "200"

step "2. project settings: authority fields are Web UI only"
ui GET "/api/projects/$PROJECT_ID/settings" > /dev/null
assert_eq "new project defaults to outboundMode=draft" "$(api_body | jq -r '.outboundMode')" "draft"
BASELINE="$(api_body)"
# One valid payload per UI-only field (services/project-settings.ts UI_ONLY_SETTINGS).
UI_ONLY_PAYLOADS=(
  'outboundMode|{"outboundMode":"send"}'
  'sendingIdentityId|{"sendingIdentityId":null}'
  'senderEmailAlias|{"senderEmailAlias":"alias@example.com"}'
  'senderDisplayName|{"senderDisplayName":"E2E Sender"}'
  'senderCompanyName|{"senderCompanyName":"E2E Co"}'
  'senderJobTitle|{"senderJobTitle":"CEO"}'
  'footerOverride|{"footerOverride":"---\nE2E"}'
  'inquiryVideoUrl|{"inquiryVideoUrl":"https://example.com/v"}'
  'inquiryPdfUrl|{"inquiryPdfUrl":"https://example.com/p.pdf"}'
  'inquiryBrandColor|{"inquiryBrandColor":"#123456"}'
  'inquiryBrandLogoUrl|{"inquiryBrandLogoUrl":"https://example.com/logo.png"}'
  'inquiryDarkBackground|{"inquiryDarkBackground":true}'
  'inquiryCtaType|{"inquiryCtaType":"meeting"}'
  'inquiryCtaUrl|{"inquiryCtaUrl":"https://example.com/book"}'
)
for entry in "${UI_ONLY_PAYLOADS[@]}"; do
  field="${entry%%|*}"; payload="${entry#*|}"
  STATUS="$(mcp PUT "/api/projects/$PROJECT_ID/settings" "$payload")"
  assert_eq "MCP $field → 403" "$STATUS" "403"
  assert_eq "  error names $field" "$(api_body | jq -r --arg f "$field" '.error | startswith($f)')" "true"
done
ui GET "/api/projects/$PROJECT_ID/settings" > /dev/null
assert_eq "settings unchanged after rejected writes" "$(api_body | jq -S 'del(.updatedAt)')" "$(echo "$BASELINE" | jq -S 'del(.updatedAt)')"
STATUS="$(mcp PUT "/api/projects/$PROJECT_ID/settings" '{"inquiryOneLiner":"e2e one-liner"}')"
assert_eq "MCP agent-owned field → 200" "$STATUS" "200"
assert_eq "value written" "$(api_body | jq -r '.inquiryOneLiner')" "e2e one-liner"
STATUS="$(ui PUT "/api/projects/$PROJECT_ID/settings" '{"outboundMode":"draft"}')"
assert_eq "browser outboundMode → 200" "$STATUS" "200"
assert_eq "outboundMode=draft" "$(api_body | jq -r '.outboundMode')" "draft"

step "3. playbook approval gate"
STATUS="$(mcp PUT "$DOCS/playbook_$PLAYBOOK_SLUG" '{"content":"# Playbook v1\ne2e"}')"
assert_eq "MCP playbook save → 201" "$STATUS" "201"
assert_eq "approvedAt null (pending)" "$(api_body | jq -r '.approvedAt')" "null"
V1="$(api_body | jq -r '.id')"
STATUS="$(mcp GET "$DOCS/playbook_$PLAYBOOK_SLUG")"
assert_eq "MCP GET pending playbook → 412" "$STATUS" "412"
STATUS="$(ui GET "$DOCS/playbook_$PLAYBOOK_SLUG")"
assert_eq "browser GET → 200 (newest, pending)" "$STATUS" "200"
assert_eq "browser sees approvedAt null" "$(api_body | jq -r '.approvedAt')" "null"
STATUS="$(mcp POST "$DOCS/playbook_$PLAYBOOK_SLUG/approve" "$(jq -nc --argjson i "$V1" '{id:$i}')")"
assert_eq "MCP approve → 403" "$STATUS" "403"
STATUS="$(ui POST "$DOCS/playbook_$PLAYBOOK_SLUG/approve" "$(jq -nc --argjson i "$V1" '{id:$i}')")"
assert_eq "browser approve → 200" "$STATUS" "200"
assert_eq "approvedAt stamped" "$(api_body | jq -r '.approvedAt != null')" "true"
STATUS="$(mcp GET "$DOCS/playbook_$PLAYBOOK_SLUG")"
assert_eq "MCP GET approved playbook → 200" "$STATUS" "200"
assert_eq "approved content served" "$(api_body | jq -r '.content')" "$(printf '# Playbook v1\ne2e')"
STATUS="$(ui POST "$DOCS/playbook_$PLAYBOOK_SLUG/approve" "$(jq -nc --argjson i "$V1" '{id:$i}')")"
assert_eq "re-approve → 409" "$STATUS" "409"
STATUS="$(ui POST "$DOCS/playbook_$PLAYBOOK_SLUG/approve" '{"id":999999999}')"
assert_eq "unknown version → 404" "$STATUS" "404"
STATUS="$(mcp PUT "$DOCS/playbook_$PLAYBOOK_SLUG" '{"content":"# Playbook v2\ne2e"}')"
assert_eq "later MCP save → 201 pending" "$STATUS" "201"
assert_eq "v2 approvedAt null" "$(api_body | jq -r '.approvedAt')" "null"
STATUS="$(mcp GET "$DOCS/playbook_$PLAYBOOK_SLUG")"
assert_eq "MCP GET still serves the approved version" "$(api_body | jq -r '.content')" "$(printf '# Playbook v1\ne2e')"
mcp GET "$DOCS/playbook_$PLAYBOOK_SLUG/history" > /dev/null
assert_eq "MCP history lists approved versions only" "$(api_body | jq -r '[.history[] | .approvedAt != null] | all and (length == 1)')" "true"
ui GET "$DOCS/playbook_$PLAYBOOK_SLUG/history" > /dev/null
assert_eq "browser history lists pending too" "$(api_body | jq -r '.history | length')" "2"
STATUS="$(ui PUT "$DOCS/playbook_$PLAYBOOK_SLUG" '{"content":"# Playbook v3\ne2e"}')"
assert_eq "browser save → 201" "$STATUS" "201"
assert_eq "browser save approved on write" "$(api_body | jq -r '.approvedAt != null')" "true"
STATUS="$(mcp GET "$DOCS/playbook_$PLAYBOOK_SLUG")"
assert_eq "MCP GET serves the browser-saved version" "$(api_body | jq -r '.content')" "$(printf '# Playbook v3\ne2e')"

step "4. non-playbook slugs are ungated"
STATUS="$(mcp PUT "$DOCS/learnings" '{"content":"[targeting] e2e"}')"
assert_eq "MCP learnings save → 201" "$STATUS" "201"
LID="$(api_body | jq -r '.id')"
STATUS="$(mcp GET "$DOCS/learnings")"
assert_eq "MCP learnings GET → 200" "$STATUS" "200"
STATUS="$(ui POST "$DOCS/learnings/approve" "$(jq -nc --argjson i "$LID" '{id:$i}')")"
assert_eq "approve on non-playbook → 400" "$STATUS" "400"

step "5. slug allowlist"
STATUS="$(mcp PUT "$DOCS/env_status" '{"content":"x"}')"
assert_eq "unknown slug → 400" "$STATUS" "400"
STATUS="$(mcp PUT "$DOCS/playbook_Bad_Slug" '{"content":"x"}')"
assert_eq "malformed playbook slug → 400" "$STATUS" "400"

step "6. add-means suggestion resolves on approval, not on the pending save"
STATUS="$(ui POST "/api/projects/$PROJECT_ID/suggestions" \
  "$(jq -nc --arg k "$SUGGESTION_SLUG" '{kind:"add-means", dedupeKey:$k, title:"t", body:"b", command:"c"}')")"
[[ "$STATUS" == "201" ]] || { echo "suggestion create failed ($STATUS): $(api_body)" >&2; exit 1; }
SID="$(api_body | jq -r '.id')"
mcp PUT "$DOCS/playbook_$SUGGESTION_SLUG" '{"content":"# pending"}' > /dev/null
PID="$(api_body | jq -r '.id')"
ui GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "still open after pending save" "$(api_body | jq -r --argjson i "$SID" '.suggestions[] | select(.id == $i) | .status')" "open"
ui POST "$DOCS/playbook_$SUGGESTION_SLUG/approve" "$(jq -nc --argjson i "$PID" '{id:$i}')" > /dev/null
ui GET "/api/projects/$PROJECT_ID/suggestions" > /dev/null
assert_eq "done after approval" "$(api_body | jq -r --argjson i "$SID" '.suggestions[] | select(.id == $i) | .status')" "done"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
