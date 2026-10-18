#!/usr/bin/env bash
# Regression for what Ace hands the person to decide (proposals) and the reach
# settings' change log:
#
#   1. A reach setting changed in the Web UI logs one policy_changes row
#      (target settings, actor user) carrying what changed; an unchanged value
#      logs nothing.
#   2. One pending loosening or frame per project (the partial unique index).
#   3. Listing; stop → stopped; stopping again → 409. Apply and stop are Web UI
#      only (MCP → 403).
#   4. The tick applies a pending loosening on its day, not before: the setting
#      changes and the change logs as Ace with the proposal's reason.
#   5. A loosening whose setting someone changed since it was written is
#      outdated on apply and changes nothing.
#   6. Apply now → applied.
#   7. A means (add-means): the agent records it beside a pending loosening; a
#      means is proposed once, whatever the person answered; apply now refuses
#      it; a browser playbook save carries out the matching one only.
#   8. A new frame: never beside a pending loosening; the tick applies it on
#      its day — the sales strategy, the reach and the options replaced, a
#      'frame' row logged where measuring restarts; one written against an
#      older sales strategy or reach is outdated; a frame the person approves
#      (the chat's card, or the Web UI) applies at once, outdates a pending
#      loosening and never lifts a pause, MCP → 403, used slugs → 400.
#   9. The dashboard journal carries the settings changes, the frame starts and
#      the proposals.
#
# Loosenings are inserted with psql: the model writes them in evaluate, which
# this harness does not run. The pure rules (what loosens, what still applies)
# are unit-tested in backend/src/domain/loop/proposal.test.ts. A playbook saved
# pending carries nothing out until approved: regression-caller-gates.sh step 6.
#
# Usage:
#   ./e2e/regression-proposals.sh
#   SKIP_CLEANUP=1 ./e2e/regression-proposals.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-proposals-$(date +%s)"
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

BODY_FILE="$(mktemp)"
api_as() { # token method path [body] → HTTP status; response body in $BODY_FILE
  local token="$1" method="$2" path="$3" body="${4:-}"
  if [[ -n "$body" ]]; then
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" \
      -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d "$body" "$API_URL$path"
  else
    curl -sS -o "$BODY_FILE" -w '%{http_code}' -X "$method" -H "Authorization: Bearer $token" "$API_URL$path"
  fi
}
ui()  { api_as "$TOKEN_UI" "$@"; }
mcp() { api_as "$TOKEN_MCP" "$@"; }
api_body() { cat "$BODY_FILE"; }
psql_local() { PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc "$1"; }

command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }
TOKEN_UI="$("$REPO_ROOT/e2e/mint-jwt.sh")"
TOKEN_MCP="$("$REPO_ROOT/e2e/mint-jwt.sh" --aud mcp)"
[[ -n "$TOKEN_UI" && -n "$TOKEN_MCP" ]] || { echo "failed to mint JWTs" >&2; exit 1; }

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
TODAY="$(date -u +%Y-%m-%d)"

step "setup: create project named \"$PROJECT_NAME\""
STATUS="$(ui POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
[[ "$STATUS" == "201" ]] || { echo "project create failed ($STATUS): $(api_body)" >&2; exit 1; }
PROJECT_ID="$(api_body | jq -r '.id')"
TENANT_ID="$(psql_local "SELECT tenant_id FROM projects WHERE id = '$PROJECT_ID';")"
SETTINGS="/api/projects/$PROJECT_ID/settings"

settings_rows() { psql_local "SELECT count(*) FROM policy_changes WHERE project_id = '$PROJECT_ID' AND target = 'settings';"; }
channels() { psql_local "SELECT array_to_string(outbound_channels, ',') FROM project_settings WHERE project_id = '$PROJECT_ID';"; }
propose() { # from-channels-json to-channels-json apply_on → id
  psql_local "INSERT INTO proposals (tenant_id, project_id, change, title, body)
              VALUES ('$TENANT_ID', '$PROJECT_ID',
                      jsonb_build_object('kind', 'loosen', 'applyOn', '$3', 'reason', 'form-only prospects: 107',
                                         'outboundChannels', jsonb_build_object('from', '$1'::jsonb, 'to', '$2'::jsonb)),
                      'Turn on form outreach', 'Form-only prospects in the Target: 107.')
              RETURNING id;" | head -1
}
status_of() { psql_local "SELECT status FROM proposals WHERE id = $1;"; }
strategy_doc_id() { psql_local "SELECT id FROM project_documents WHERE project_id = '$PROJECT_ID' AND slug = 'sales_strategy' ORDER BY created_at DESC, id DESC LIMIT 1;"; }
propose_frame() { # sales-strategy-from apply_on tag → id
  psql_local "INSERT INTO proposals (tenant_id, project_id, change, title, body)
              VALUES ('$TENANT_ID', '$PROJECT_ID',
                      jsonb_build_object('kind', 'frame', 'applyOn', '$2', 'reason', 'no positive in 120 trials', 'salesStrategyFrom', $1,
                        'reachFrom', (SELECT jsonb_build_object('outboundChannels', to_jsonb(outbound_channels), 'targetCountries', to_jsonb(target_countries), 'targetLanguage', target_language)
                                      FROM project_settings WHERE project_id = '$PROJECT_ID'),
                        'salesStrategy', '# Strategy $3',
                        'reach', (SELECT jsonb_build_object('outboundChannels', to_jsonb(outbound_channels), 'targetCountries', '[\"JP\",\"US\"]'::jsonb, 'targetLanguage', target_language)
                                  FROM project_settings WHERE project_id = '$PROJECT_ID'),
                        'variants', jsonb_build_array(
                          jsonb_build_object('variantId', 'frame_$3_1', 'label', 'A', 'subjectPattern', 's {{org}}', 'bodyApproach', 'b'),
                          jsonb_build_object('variantId', 'frame_$3_2', 'label', 'B', 'subjectPattern', 't {{org}}', 'bodyApproach', 'b')),
                        'strategies', jsonb_build_array(
                          jsonb_build_object('slug', '$3-a', 'approach', 'a'),
                          jsonb_build_object('slug', '$3-b', 'approach', 'b'))),
                      'Reach nursing schools', 'Medical prep schools: 0 positive in 120 trials.')
              RETURNING id;" | head -1
}
active_options() { psql_local "SELECT (SELECT string_agg(variant_id, ',' ORDER BY variant_id) FROM message_variants WHERE project_id = '$PROJECT_ID' AND archived_at IS NULL) || ' | ' || (SELECT string_agg(slug, ',' ORDER BY slug) FROM discovery_strategies WHERE project_id = '$PROJECT_ID' AND archived_at IS NULL);"; }
frame_body() { # tag
  jq -nc --arg t "$1" '{salesStrategy:("# Strategy " + $t), outboundChannels:["email"], targetCountries:["JP"], targetLanguage:"en",
    variants:[{label:"C", subjectPattern:"u {{org}}", bodyApproach:"b"}, {label:"D", subjectPattern:"v {{org}}", bodyApproach:"b"}],
    strategies:[{slug:($t + "-a"), approach:"a"}, {slug:($t + "-b"), approach:"b"}], reason:"the person asked for clinics"}'
}
means_body() { # strategy title
  jq -nc --arg s "$1" --arg t "$2" '{strategy:$s, title:$t, body:"Upwork posts match the Target.", instruction:"Add Upwork as an outreach means."}'
}

step "1. a reach setting changed in the Web UI is logged with what changed"
STATUS="$(ui PUT "$SETTINGS" '{"targetCountries":["JP"]}')"
assert_eq "PUT targetCountries → 200" "$STATUS" "200"
assert_eq "one settings row" "$(settings_rows)" "1"
assert_eq "row carries the change, by the user" \
  "$(psql_local "SELECT actor || ' ' || (reach_diff->'targetCountries')::text FROM policy_changes WHERE project_id = '$PROJECT_ID' AND target = 'settings';")" \
  'user {"to": ["JP"], "from": []}'
ui PUT "$SETTINGS" '{"targetCountries":["JP"],"inquiryOneLiner":"probe"}' > /dev/null
assert_eq "an unchanged value logs nothing" "$(settings_rows)" "1"

step "2. one pending loosening per project"
P1="$(propose '["email"]' '["email","form"]' "$TODAY")"
[[ -n "$P1" ]] || { echo "proposal insert failed" >&2; exit 1; }
DUP="$(propose '["email"]' '["email","sns_linkedin"]' "$TODAY" 2>&1)"
assert_eq "a second pending one is refused" "$(echo "$DUP" | grep -c uq_proposals_pending)" "1"

step "3. list, stop, gates"
STATUS="$(ui GET "/api/projects/$PROJECT_ID/proposals?status=pending")"
assert_eq "list → 200" "$STATUS" "200"
assert_eq "the pending one, with its change" "$(api_body | jq -r '.proposals | map("\(.id) \(.change.outboundChannels.to | join(","))") | join(";")')" "$P1 email,form"
STATUS="$(mcp POST "/api/proposals/$P1/stop")"
assert_eq "MCP stop → 403" "$STATUS" "403"
STATUS="$(mcp POST "/api/proposals/$P1/apply")"
assert_eq "MCP apply → 403" "$STATUS" "403"
STATUS="$(ui POST "/api/proposals/$P1/stop")"
assert_eq "browser stop → 200" "$STATUS" "200"
assert_eq "stopped" "$(status_of "$P1")" "stopped"
STATUS="$(ui POST "/api/proposals/$P1/stop")"
assert_eq "stop again → 409" "$STATUS" "409"
assert_eq "channels untouched" "$(channels)" "email"

step "4. the tick applies a proposal on its day, not before"
TOMORROW="$(date -u -v+1d +%Y-%m-%d 2>/dev/null || date -u -d tomorrow +%Y-%m-%d)"
P2="$(propose '["email"]' '["email","form"]' "$TOMORROW")"
ui POST "/api/projects/$PROJECT_ID/run-lever-tick" > /dev/null
assert_eq "before its day: still pending" "$(status_of "$P2")" "pending"
psql_local "UPDATE proposals SET change = jsonb_set(change, '{applyOn}', to_jsonb('$TODAY'::text)) WHERE id = $P2;" > /dev/null
ui POST "/api/projects/$PROJECT_ID/run-lever-tick" > /dev/null
assert_eq "on its day: applied" "$(status_of "$P2")" "applied"
assert_eq "the setting changed" "$(channels)" "email,form"
assert_eq "logged as Ace with the proposal's reason" \
  "$(psql_local "SELECT actor || ' | ' || reason FROM policy_changes WHERE project_id = '$PROJECT_ID' AND target = 'settings' ORDER BY id DESC LIMIT 1;")" \
  "ace | form-only prospects: 107"

step "5. a setting changed since the proposal was written: outdated"
P3="$(propose '["email","form"]' '["email","form","sns_linkedin"]' "$TOMORROW")"
ui PUT "$SETTINGS" '{"outboundChannels":["email"]}' > /dev/null
STATUS="$(ui POST "/api/proposals/$P3/apply")"
assert_eq "apply → 200" "$STATUS" "200"
assert_eq "reported outdated" "$(api_body | jq -r '.status')" "outdated"
assert_eq "outdated" "$(status_of "$P3")" "outdated"
assert_eq "the person's setting stands" "$(channels)" "email"

step "6. apply now"
P4="$(propose '["email"]' '["email","form"]' "$TOMORROW")"
STATUS="$(ui POST "/api/proposals/$P4/apply")"
assert_eq "apply → 200" "$STATUS" "200"
assert_eq "applied" "$(status_of "$P4")" "applied"
assert_eq "the setting changed" "$(channels)" "email,form"

step "7. a means the person sets up"
P5="$(propose '["email","form"]' '["email","form","sns_linkedin"]' "$TOMORROW")"
STATUS="$(mcp POST "/api/projects/$PROJECT_ID/proposals" "$(means_body upwork 'Try Upwork')")"
assert_eq "agent records a means → 201" "$STATUS" "201"
M1="$(api_body | jq -r '.id')"
assert_eq "beside the pending loosening" "$(psql_local "SELECT count(*) FROM proposals WHERE project_id = '$PROJECT_ID' AND status = 'pending';")" "2"
STATUS="$(mcp POST "/api/projects/$PROJECT_ID/proposals" "$(means_body upwork 'Try Upwork again')")"
assert_eq "the same means again → 200, not recorded" "$STATUS $(api_body | jq -r '.recorded')" "200 false"
STATUS="$(ui POST "/api/proposals/$M1/apply")"
assert_eq "apply now refuses a means → 409" "$STATUS" "409"
ui POST "/api/proposals/$M1/stop" > /dev/null
mcp POST "/api/projects/$PROJECT_ID/proposals" "$(means_body upwork 'Try Upwork once more')" > /dev/null
assert_eq "stopped, it is not proposed again" "$(api_body | jq -r '.recorded')" "false"
mcp POST "/api/projects/$PROJECT_ID/proposals" "$(means_body kaggle 'Try Kaggle')" > /dev/null
M2="$(api_body | jq -r '.id')"
ui PUT "/api/projects/$PROJECT_ID/documents/sales_strategy" '{"content":"# Strategy\ne2e probe"}' > /dev/null
assert_eq "another document carries out nothing" "$(status_of "$M2")" "pending"
STATUS="$(ui PUT "/api/projects/$PROJECT_ID/documents/playbook_kaggle" '{"content":"# Playbook\ne2e probe"}')"
assert_eq "browser playbook save → 201" "$STATUS" "201"
assert_eq "its means → applied" "$(status_of "$M2")" "applied"
assert_eq "the stopped one untouched" "$(status_of "$M1")" "stopped"
assert_eq "the loosening untouched" "$(status_of "$P5")" "pending"
STATUS="$(mcp POST "/api/projects/$PROJECT_ID/proposals" "$(jq -nc '{strategy:"Bad_Slug", title:"t", body:"b", instruction:"i"}')")"
assert_eq "a strategy that is not a slug → 400" "$STATUS" "400"
STATUS="$(mcp POST "/api/projects/$PROJECT_ID/proposals" "$(jq -nc '{strategy:"wantedly", title:"t", body:"b"}')")"
assert_eq "no instruction → 400" "$STATUS" "400"

step "8. a new frame"
psql_local "INSERT INTO message_variants (tenant_id, project_id, variant_id, subject_pattern) VALUES ('$TENANT_ID', '$PROJECT_ID', 'v1', 'old {{org}}');
            INSERT INTO discovery_strategies (tenant_id, project_id, slug, approach) VALUES ('$TENANT_ID', '$PROJECT_ID', 'old-search', 'old');" > /dev/null
DUP="$(propose_frame "$(strategy_doc_id)" "$TODAY" dup 2>&1)"
assert_eq "a frame beside a pending loosening is refused" "$(echo "$DUP" | grep -c uq_proposals_pending)" "1"
ui POST "/api/proposals/$P5/stop" > /dev/null
F1="$(propose_frame "$(strategy_doc_id)" "$TODAY" nurse)"
[[ -n "$F1" ]] || { echo "frame insert failed" >&2; exit 1; }
DUP="$(propose_frame "$(strategy_doc_id)" "$TOMORROW" dup 2>&1)"
assert_eq "a second pending frame is refused" "$(echo "$DUP" | grep -c uq_proposals_pending)" "1"
ui POST "/api/projects/$PROJECT_ID/run-lever-tick" > /dev/null
assert_eq "on its day: applied" "$(status_of "$F1")" "applied"
assert_eq "the sales strategy is the frame's" \
  "$(psql_local "SELECT content FROM project_documents WHERE id = $(strategy_doc_id);")" "# Strategy nurse"
assert_eq "the reach changed" "$(psql_local "SELECT array_to_string(target_countries, ',') FROM project_settings WHERE project_id = '$PROJECT_ID';")" "JP,US"
assert_eq "the options are the frame's" "$(active_options)" "frame_nurse_1,frame_nurse_2 | nurse-a,nurse-b"
assert_eq "a frame row by Ace with the reason" \
  "$(psql_local "SELECT actor || ' | ' || reason FROM policy_changes WHERE project_id = '$PROJECT_ID' AND target = 'frame';")" "ace | no positive in 120 trials"
assert_eq "the tick decided on the frame signal" \
  "$(psql_local "SELECT decision ? 'frame' FROM lever_decisions WHERE project_id = '$PROJECT_ID' ORDER BY cycle_date DESC LIMIT 1;")" "t"
OLD_DOC="$(strategy_doc_id)"
F2="$(propose_frame "$OLD_DOC" "$TOMORROW" clinic)"
ui PUT "/api/projects/$PROJECT_ID/documents/sales_strategy" '{"content":"# Strategy edited by the person"}' > /dev/null
STATUS="$(ui POST "/api/proposals/$F2/apply")"
assert_eq "written against an older sales strategy: outdated" "$STATUS $(status_of "$F2")" "200 outdated"
assert_eq "the person's edit stands" "$(psql_local "SELECT content FROM project_documents WHERE id = $(strategy_doc_id);")" "# Strategy edited by the person"
assert_eq "the options untouched" "$(active_options)" "frame_nurse_1,frame_nurse_2 | nurse-a,nurse-b"
F3="$(propose_frame "$(strategy_doc_id)" "$TOMORROW" dental)"
ui PUT "$SETTINGS" '{"targetLanguage":"ja"}' > /dev/null
STATUS="$(ui POST "/api/proposals/$F3/apply")"
assert_eq "a reach field it does not change moved: outdated" "$STATUS $(status_of "$F3")" "200 outdated"
STATUS="$(mcp POST "/api/projects/$PROJECT_ID/frame" "$(frame_body clinic)")"
assert_eq "MCP frame → 403" "$STATUS" "403"
STATUS="$(ui POST "/api/projects/$PROJECT_ID/frame" "$(frame_body nurse)")"
assert_eq "slugs the project used → 400" "$STATUS" "400"
P6="$(propose '["email","form"]' '["email","form","sns_linkedin"]' "$TOMORROW")"
STATUS="$(ui POST "/api/projects/$PROJECT_ID/frame" "$(frame_body clinic)")"
assert_eq "an approved frame applies at once → 200" "$STATUS" "200"
assert_eq "the reach is the frame's" "$(psql_local "SELECT array_to_string(outbound_channels, ',') || ' ' || array_to_string(target_countries, ',') || ' ' || target_language FROM project_settings WHERE project_id = '$PROJECT_ID';")" "email JP en"
assert_eq "the pending loosening is outdated" "$(status_of "$P6")" "outdated"
assert_eq "its options, on fresh ids" "$(active_options)" "frame_${TODAY//-/}_1,frame_${TODAY//-/}_2 | clinic-a,clinic-b"
assert_eq "a frame row by the person" \
  "$(psql_local "SELECT actor || ' | ' || reason FROM policy_changes WHERE project_id = '$PROJECT_ID' AND target = 'frame' ORDER BY id DESC LIMIT 1;")" "user | the person asked for clinics"
ui PUT "$SETTINGS" '{"outboundChannels":[]}' > /dev/null
STATUS="$(ui POST "/api/projects/$PROJECT_ID/frame" "$(frame_body vet)")"
assert_eq "a frame on a paused project → 200" "$STATUS" "200"
assert_eq "the pause stands" "$(channels)" ""

step "9. the dashboard journal"
STATUS="$(ui GET "/api/projects/$PROJECT_ID/dashboard")"
assert_eq "dashboard → 200" "$STATUS" "200"
assert_eq "settings changes journaled" "$(api_body | jq -r '[.journal[] | select(.kind == "settings")] | length')" "8"
assert_eq "frame starts journaled" "$(api_body | jq -r '[.journal[] | select(.kind == "frame") | .actor] | sort | join(",")')" "ace,user,user"
assert_eq "proposals journaled with their outcome" \
  "$(api_body | jq -r '[.journal[] | select(.kind == "proposed") | .status] | sort | join(",")')" "applied,applied,applied,applied,outdated,outdated,outdated,outdated,stopped,stopped,stopped"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
