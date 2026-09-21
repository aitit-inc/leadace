#!/usr/bin/env bash
# Regression for draft review records (#678): what a person does to a draft in
# review is kept in draft_reviews, and the two kinds of discard differ in what
# happens to the prospect.
#
#   1. Editing a draft keeps the agent's text once: the first change inserts an
#      'edited' row with the original subject/body; a second edit and a no-op
#      save add nothing and leave the original alone.
#   2. Discard as "wrong message" (the default): the draft row is deleted, the
#      review row stays (outreach_log_id NULL) with the note, the prospect is
#      reachable again. An already-edited draft keeps the agent's original text.
#   3. Discard as "wrong prospect": project_prospects.status becomes 'inactive'
#      and the prospect is not reachable.
#   4. A sent draft cannot be discarded (409) and gets no discard record.
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres).
# Curl-only, cleans up (project delete cascades to draft_reviews).
#
# Usage:
#   ./e2e/regression-draft-reviews.sh
#   SKIP_CLEANUP=1 ./e2e/regression-draft-reviews.sh
#
# Exit status: 0 all passed · 1 setup/HTTP failure · 2 assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-draft-review-$(date +%s)"
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

# Is prospect-id $2 present in the listReachable JSON $1? prints y/n.
reachable_has() {
  echo "$1" | jq -e --argjson id "$2" '[.prospects[]?.prospectId] | index($id) != null' >/dev/null 2>&1 \
    && echo y || echo n
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

restore_and_exit() {
  local rc=$?
  if [[ "$SKIP_CLEANUP" == "1" ]]; then
    echo "" >&2; echo "SKIP_CLEANUP=1 — leaving project_id=${PROJECT_ID:-<none>} and run-tagged rows in place." >&2
    exit "$rc"
  fi
  echo "" >&2; echo "=== teardown ===" >&2
  if [[ -n "${PROJECT_ID:-}" ]]; then
    api DELETE "/api/projects/$PROJECT_ID" > /dev/null || true
    say "deleted project $PROJECT_ID"
  fi
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE 'contact@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped tenant-scope test rows tagged $RUN_TAG"
  exit "$rc"
}
trap restore_and_exit EXIT

step "create project + seed 3 US prospects, one draft each"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

SEED_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed msg)" --argjson b "$(mkseed who)" --argjson c "$(mkseed sent)" \
  '{projectId:$pid, prospects:[$a,$b,$c]}')"
assert_eq "seed inserted=3" "$(api POST /api/prospects/batch "$SEED_BODY" | jq -r '.inserted // 0')" "3"
LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_MSG="$(pid_of msg)"; P_WHO="$(pid_of who)"; P_SENT="$(pid_of sent)"
[[ -n "$P_MSG" && -n "$P_WHO" && -n "$P_SENT" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }

mkdraft() {
  api POST /api/outreach "$(jq -nc --arg pid "$PROJECT_ID" --argjson prid "$1" \
    '{projectId:$pid, prospectId:$prid, channel:"email", subject:"agent subject", body:"agent body", status:"pending_review"}')" | jq -r '.id'
}
D_MSG="$(mkdraft "$P_MSG")"; D_WHO="$(mkdraft "$P_WHO")"; D_SENT="$(mkdraft "$P_SENT")"
say "drafts: msg=$D_MSG who=$D_WHO sent=$D_SENT"
review_of() { psql_local "SELECT verdict || '|' || coalesce(note,'') || '|' || coalesce(agent_subject,'') || '|' || agent_body || '|' || coalesce(outreach_log_id::text,'null') FROM draft_reviews WHERE project_id='$PROJECT_ID' AND prospect_id=$1;"; }
reviews_count() { psql_local "SELECT count(*)::int FROM draft_reviews WHERE project_id='$PROJECT_ID';"; }

step "1. an edit keeps the agent's text, once"
api PUT "/api/outreach/drafts/$D_MSG" '{"subject":"agent subject","body":"agent body"}' > /dev/null
assert_eq "a save that changes nothing records nothing" "$(reviews_count)" "0"
api PUT "/api/outreach/drafts/$D_MSG" '{"body":"the person rewrote this"}' > /dev/null
assert_eq "first edit records the original" "$(review_of "$P_MSG")" "edited||agent subject|agent body|$D_MSG"
api PUT "/api/outreach/drafts/$D_MSG" '{"body":"and rewrote it again"}' > /dev/null
assert_eq "second edit leaves the original alone" "$(review_of "$P_MSG")" "edited||agent subject|agent body|$D_MSG"
assert_eq "still one review row" "$(reviews_count)" "1"

step "2. discard as wrong message (default verdict) — prospect comes back"
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"note":"the funding news is a year old"}' "$API_URL/api/outreach/drafts/$D_MSG")"
assert_eq "DELETE with a note → 200" "$STATUS" "200"
assert_eq "review keeps the agent's original, row link cleared" "$(review_of "$P_MSG")" "wrong_message|the funding news is a year old|agent subject|agent body|null"
assert_eq "draft row is gone" "$(psql_local "SELECT count(*)::int FROM outreach_logs WHERE id=$D_MSG;")" "0"
R1="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "prospect reachable again" "$(reachable_has "$R1" "$P_MSG")" "y"

step "3. discard as wrong prospect — prospect leaves the project"
RESP="$(api POST /api/outreach/drafts/discard "$(jq -nc --argjson id "$D_WHO" '{ids:[$id], verdict:"wrong_prospect", note:"we do not sell to agencies"}')")"
assert_eq "batch discard deleted 1" "$(echo "$RESP" | jq -r '.deletedIds | length')" "1"
assert_eq "review recorded" "$(review_of "$P_WHO")" "wrong_prospect|we do not sell to agencies|agent subject|agent body|null"
assert_eq "prospect inactive in the project" "$(psql_local "SELECT status FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=$P_WHO;")" "inactive"
R2="$(api GET "/api/projects/$PROJECT_ID/prospects/reachable?limit=200")"
assert_eq "prospect not reachable" "$(reachable_has "$R2" "$P_WHO")" "n"

step "4. a sent draft is not discardable and gets no record"
psql_local "UPDATE outreach_logs SET status='sent' WHERE id=$D_SENT;" > /dev/null
STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"verdict":"wrong_prospect"}' "$API_URL/api/outreach/drafts/$D_SENT")"
assert_eq "DELETE on a sent row → 409" "$STATUS" "409"
assert_eq "no review row for it" "$(review_of "$P_SENT")" ""
assert_eq "its prospect status untouched" "$(psql_local "SELECT status FROM project_prospects WHERE project_id='$PROJECT_ID' AND prospect_id=$P_SENT;")" "new"
RESP="$(api POST /api/outreach/drafts/discard "$(jq -nc --argjson id "$D_SENT" '{ids:[$id]}')")"
assert_eq "batch discard skips it" "$(echo "$RESP" | jq -c '[(.deletedIds | length), (.skippedIds | length)]')" "[0,1]"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
