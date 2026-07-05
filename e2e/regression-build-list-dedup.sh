#!/usr/bin/env bash
# Curl-based regression for the build-list dedup flow:
#   - POST /prospects/check-dedup (the new pre-flight)
#   - normalize-domain transform on both prospectInputSchema and dedupCandidateSchema
#   - DedupSkipReason coverage: do_not_contact / email_duplicate / form_url_duplicate /
#     already_in_project / duplicate_in_batch
#
# Runs against the local stack (localhost:8787 API + 54322 Postgres). Mints
# its own JWT via mint-jwt.sh, registers a fresh batch of test prospects in a
# throwaway project, exercises check-dedup variants, and cleans up the project
# + tenant-level test rows by domain/email prefix.
#
# Usage:
#   ./e2e/regression-build-list-dedup.sh
#   SKIP_CLEANUP=1 ./e2e/regression-build-list-dedup.sh   # leave artifacts
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-dedup-$(date +%s)"
PROJECT_NAME="$RUN_TAG project"
DOMAIN_A="$RUN_TAG-a.example"
DOMAIN_B="$RUN_TAG-b.example"
DOMAIN_C="$RUN_TAG-c.example"
DOMAIN_D="$RUN_TAG-d.example"
DOMAIN_E="$RUN_TAG-e.example"
DOMAIN_FRESH="$RUN_TAG-fresh.example"
EMAIL_A="contact@$DOMAIN_A"
EMAIL_B="contact@$DOMAIN_B"
EMAIL_E="contact@$DOMAIN_E"
EMAIL_FRESH="contact@$DOMAIN_FRESH"
FORM_C="https://$DOMAIN_C/contact"
FORM_FRESH="https://$DOMAIN_FRESH/inquiry"

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
    curl -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      -H 'Content-Type: application/json' \
      -d "$body" \
      "$API_URL$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $TOKEN" \
      "$API_URL$path"
  fi
}

require_jq() {
  command -v jq >/dev/null 2>&1 || { echo "need jq on PATH" >&2; exit 1; }
}

require_jq
TOKEN="$("$REPO_ROOT/e2e/mint-jwt.sh")"
[[ -n "$TOKEN" ]] || { echo "failed to mint JWT" >&2; exit 1; }

step "preflight"
HEALTH="$(curl -sS "$API_URL/health" || true)"
[[ "$(echo "$HEALTH" | jq -r .ok 2>/dev/null)" == "true" ]] || { echo "API not healthy: $HEALTH" >&2; exit 1; }
say "API healthy"

step "create test project ($PROJECT_NAME)"
CREATE_RESP="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')")"
PROJECT_ID="$(echo "$CREATE_RESP" | jq -r .id)"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]] || { echo "create-project failed: $CREATE_RESP" >&2; exit 1; }
say "project_id=$PROJECT_ID"

# Register a known set of prospects in the project. After this:
#   A: org domain $DOMAIN_A, has email $EMAIL_A          (tenant + project)
#   B: org domain $DOMAIN_B, has email $EMAIL_B          (tenant + project)
#   C: org domain $DOMAIN_C, has form $FORM_C            (tenant + project)
#   D: org domain $DOMAIN_D, has email contact-d@... (form-less, project-level dedup demo)
#   E: org domain $DOMAIN_E, has email $EMAIL_E, DNC=true (set after register via PATCH)
step "seed prospects via /prospects/batch"
SEED_BODY="$(jq -nc \
  --arg pid "$PROJECT_ID" \
  --arg dA "$DOMAIN_A" --arg dB "$DOMAIN_B" --arg dC "$DOMAIN_C" --arg dD "$DOMAIN_D" --arg dE "$DOMAIN_E" \
  --arg eA "$EMAIL_A" --arg eB "$EMAIL_B" --arg eE "$EMAIL_E" \
  --arg fC "$FORM_C" \
  '{projectId: $pid,
    prospects: [
      {organizationDomain:$dA, organizationName:"Org A", organizationWebsiteUrl:("https://"+$dA),
       name:"Prospect A", overview:"seed A", websiteUrl:("https://"+$dA+"/about"), email:$eA, matchReason:"seed"},
      {organizationDomain:$dB, organizationName:"Org B", organizationWebsiteUrl:("https://"+$dB),
       name:"Prospect B", overview:"seed B", websiteUrl:("https://"+$dB+"/about"), email:$eB, matchReason:"seed"},
      {organizationDomain:$dC, organizationName:"Org C", organizationWebsiteUrl:("https://"+$dC),
       name:"Prospect C", overview:"seed C", websiteUrl:("https://"+$dC+"/about"), contactFormUrl:$fC, matchReason:"seed"},
      {organizationDomain:$dD, organizationName:"Org D", organizationWebsiteUrl:("https://"+$dD),
       name:"Prospect D", overview:"seed D", websiteUrl:("https://"+$dD+"/about"), email:("contact-d@"+$dD), matchReason:"seed"},
      {organizationDomain:$dE, organizationName:"Org E", organizationWebsiteUrl:("https://"+$dE),
       name:"Prospect E", overview:"seed E", websiteUrl:("https://"+$dE+"/about"), email:$eE, matchReason:"seed"}
    ]}')"
SEED_RESP="$(api POST /api/prospects/batch "$SEED_BODY")"
INSERTED="$(echo "$SEED_RESP" | jq -r '.inserted // 0')"
say "inserted=$INSERTED skipped=$(echo "$SEED_RESP" | jq -r '.skipped // 0')"
assert_eq "seed inserted=5" "$INSERTED" "5"

PROSPECT_E_ID="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200" \
  | jq -r --arg e "$EMAIL_E" '.prospects[] | select(.email == $e) | .prospectId' | head -1)"
[[ -n "$PROSPECT_E_ID" && "$PROSPECT_E_ID" != "null" ]] || { echo "could not locate prospect E id" >&2; exit 1; }
DNC_RESP="$(api PATCH "/api/prospects/$PROSPECT_E_ID/do-not-contact" '{"doNotContact":true}')"
DNC_OK="$(echo "$DNC_RESP" | jq -r '.doNotContact')"
assert_eq "DNC flipped on prospect E" "$DNC_OK" "true"

step "Test A: tenant scope (no projectId) — email/form match only"
# B.email appears twice: both skip as email_duplicate, not duplicate_in_batch —
# the intra-batch claim only fires for fresh inserts; an existing email always skips.
A_BODY="$(jq -nc \
  --arg dA "$DOMAIN_A" --arg dC "$DOMAIN_C" --arg dE "$DOMAIN_E" --arg dF "$DOMAIN_FRESH" --arg dB "$DOMAIN_B" \
  --arg eA "$EMAIL_A" --arg fC "$FORM_C" --arg eE "$EMAIL_E" --arg eF "$EMAIL_FRESH" --arg eB "$EMAIL_B" \
  '{candidates:[
    {organizationDomain:$dA, email:$eA},
    {organizationDomain:$dC, contactFormUrl:$fC},
    {organizationDomain:$dE, email:$eE},
    {organizationDomain:$dF, email:$eF},
    {organizationDomain:$dB, email:$eB},
    {organizationDomain:$dB, email:$eB}
  ]}')"
A_RESP="$(api POST /api/prospects/check-dedup "$A_BODY")"
assert_eq "A[0] kind=skip"      "$(echo "$A_RESP" | jq -r '.decisions[0].kind')"   "skip"
assert_eq "A[0] reason"         "$(echo "$A_RESP" | jq -r '.decisions[0].reason')" "email_duplicate"
assert_eq "A[1] kind=skip"      "$(echo "$A_RESP" | jq -r '.decisions[1].kind')"   "skip"
assert_eq "A[1] reason"         "$(echo "$A_RESP" | jq -r '.decisions[1].reason')" "form_url_duplicate"
assert_eq "A[2] kind=skip"      "$(echo "$A_RESP" | jq -r '.decisions[2].kind')"   "skip"
assert_eq "A[2] reason=DNC"     "$(echo "$A_RESP" | jq -r '.decisions[2].reason')" "do_not_contact"
assert_eq "A[3] kind=fresh"     "$(echo "$A_RESP" | jq -r '.decisions[3].kind')"   "fresh"
assert_eq "A[4] kind=skip"      "$(echo "$A_RESP" | jq -r '.decisions[4].kind')"   "skip"
assert_eq "A[4] reason"         "$(echo "$A_RESP" | jq -r '.decisions[4].reason')" "email_duplicate"
assert_eq "A[5] kind=skip"      "$(echo "$A_RESP" | jq -r '.decisions[5].kind')"   "skip"
assert_eq "A[5] reason"         "$(echo "$A_RESP" | jq -r '.decisions[5].reason')" "email_duplicate"

step "Test B: project scope — domain dedup activates"
# Candidates carry no email/form so nothing short-circuits the domain path.
B_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --arg dA "$DOMAIN_A" --arg dD "$DOMAIN_D" --arg dF "$DOMAIN_FRESH" \
  '{projectId:$pid, candidates:[
    {organizationDomain:$dA},
    {organizationDomain:$dD},
    {organizationDomain:$dF}
  ]}')"
B_RESP="$(api POST /api/prospects/check-dedup "$B_BODY")"
assert_eq "B[0] kind=skip"     "$(echo "$B_RESP" | jq -r '.decisions[0].kind')"   "skip"
assert_eq "B[0] reason"        "$(echo "$B_RESP" | jq -r '.decisions[0].reason')" "already_in_project"
assert_eq "B[1] kind=skip"     "$(echo "$B_RESP" | jq -r '.decisions[1].kind')"   "skip"
assert_eq "B[1] reason"        "$(echo "$B_RESP" | jq -r '.decisions[1].reason')" "already_in_project"
assert_eq "B[2] kind=fresh"    "$(echo "$B_RESP" | jq -r '.decisions[2].kind')"   "fresh"

step "Test C: normalize-domain transform — apex/url/www/path all converge"
C_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --arg apex "$DOMAIN_A" \
  --arg withWww "www.$DOMAIN_A" \
  --arg withScheme "https://$DOMAIN_A/about" \
  --arg fullUrl "https://www.$DOMAIN_A/contact?ref=ai" \
  --arg upper "HTTPS://$DOMAIN_A" \
  '{projectId:$pid, candidates:[
    {organizationDomain:$apex},
    {organizationDomain:$withWww},
    {organizationDomain:$withScheme},
    {organizationDomain:$fullUrl},
    {organizationDomain:$upper}
  ]}')"
C_RESP="$(api POST /api/prospects/check-dedup "$C_BODY")"
for i in 0 1 2 3 4; do
  assert_eq "C[$i] kind=skip"       "$(echo "$C_RESP" | jq -r ".decisions[$i].kind")"   "skip"
  assert_eq "C[$i] reason"          "$(echo "$C_RESP" | jq -r ".decisions[$i].reason")" "already_in_project"
done

step "Test D: intra-batch claim — fresh first, duplicate_in_batch second"
# Tenant scope so only the email claim path is exercised.
D_BODY="$(jq -nc --arg dF "$DOMAIN_FRESH" --arg eF "$EMAIL_FRESH" \
  '{candidates:[
    {organizationDomain:$dF, email:$eF},
    {organizationDomain:$dF, email:$eF}
  ]}')"
D_RESP="$(api POST /api/prospects/check-dedup "$D_BODY")"
assert_eq "D[0] kind=fresh"  "$(echo "$D_RESP" | jq -r '.decisions[0].kind')"   "fresh"
assert_eq "D[1] kind=skip"   "$(echo "$D_RESP" | jq -r '.decisions[1].kind')"   "skip"
assert_eq "D[1] reason"      "$(echo "$D_RESP" | jq -r '.decisions[1].reason')" "duplicate_in_batch"

step "Test D2: intra-batch domain claim — fresh then duplicate_in_batch (project scope)"
D2_BODY="$(jq -nc --arg pid "$PROJECT_ID" --arg dF "$DOMAIN_FRESH" --arg fF "$FORM_FRESH" \
  '{projectId:$pid, candidates:[
    {organizationDomain:$dF, contactFormUrl:$fF},
    {organizationDomain:$dF}
  ]}')"
D2_RESP="$(api POST /api/prospects/check-dedup "$D2_BODY")"
assert_eq "D2[0] kind=fresh"  "$(echo "$D2_RESP" | jq -r '.decisions[0].kind')"   "fresh"
assert_eq "D2[1] kind=skip"   "$(echo "$D2_RESP" | jq -r '.decisions[1].kind')"   "skip"
assert_eq "D2[1] reason"      "$(echo "$D2_RESP" | jq -r '.decisions[1].reason')" "duplicate_in_batch"

step "Test E: prospectInputSchema normalize-domain parity (silent dedup miss fix)"
# normalizeDomain applies to prospectInputSchema as well, so a register call
# passing https://www.<existing>/path lands on the same org row instead of
# creating a near-duplicate.
E_BODY="$(jq -nc --arg pid "$PROJECT_ID" \
  --arg dirty "https://www.$DOMAIN_A/about" \
  '{projectId:$pid, candidates:[
    {organizationDomain:$dirty}
  ]}')"
E_RESP="$(api POST /api/prospects/check-dedup "$E_BODY")"
assert_eq "E[0] kind=skip"   "$(echo "$E_RESP" | jq -r '.decisions[0].kind')"   "skip"
assert_eq "E[0] reason"      "$(echo "$E_RESP" | jq -r '.decisions[0].reason')" "already_in_project"

step "Test F: Phase 1.5 parity — check-dedup breakdown == /prospects/batch skippedDetails"
# Seed 10 fresh prospects in a fresh project (5 email-only, 5 form-only) so
# we have a clean dedup-source set isolated from the A-E setup.
F_PROJECT="$(api POST /api/projects "$(jq -nc --arg n "$RUN_TAG parity" '{name:$n}')" | jq -r .id)"
[[ -n "$F_PROJECT" && "$F_PROJECT" != "null" ]] || { echo "F: create-project failed" >&2; exit 1; }
say "parity project_id=$F_PROJECT"

F_PREFIX="$RUN_TAG-f"
F_SEED_BODY="$(jq -nc --arg pid "$F_PROJECT" --arg pfx "$F_PREFIX" '
  def emailSeed(i): {
    organizationDomain: ($pfx + "-e" + (i|tostring) + ".example"),
    organizationName: ("OrgE" + (i|tostring)),
    organizationWebsiteUrl: ("https://" + $pfx + "-e" + (i|tostring) + ".example"),
    name: ("Pemail" + (i|tostring)),
    overview: "seed",
    websiteUrl: ("https://" + $pfx + "-e" + (i|tostring) + ".example/about"),
    email: ("p" + (i|tostring) + "@" + $pfx + "-e" + (i|tostring) + ".example"),
    matchReason: "seed"
  };
  def formSeed(i): {
    organizationDomain: ($pfx + "-fm" + (i|tostring) + ".example"),
    organizationName: ("OrgF" + (i|tostring)),
    organizationWebsiteUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example"),
    name: ("Pform" + (i|tostring)),
    overview: "seed",
    websiteUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example/about"),
    contactFormUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example/contact"),
    matchReason: "seed"
  };
  {projectId:$pid,
   prospects: [range(0;10)] | map(if . < 5 then emailSeed(.) else formSeed(. - 5) end)
  }')"
F_SEED_RESP="$(api POST /api/prospects/batch "$F_SEED_BODY")"
assert_eq "F seed inserted=10" "$(echo "$F_SEED_RESP" | jq -r .inserted)" "10"

# Build a 20-candidate set: 5 email-dup + 5 form-dup + 10 fresh.
F_CHECK_BODY="$(jq -nc --arg pid "$F_PROJECT" --arg pfx "$F_PREFIX" '
  def emailDup(i): {
    organizationDomain: ($pfx + "-e" + (i|tostring) + ".example"),
    email: ("p" + (i|tostring) + "@" + $pfx + "-e" + (i|tostring) + ".example")
  };
  def formDup(i): {
    organizationDomain: ($pfx + "-fm" + (i|tostring) + ".example"),
    contactFormUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example/contact")
  };
  def freshCand(i): {
    organizationDomain: ($pfx + "-new" + (i|tostring) + ".example"),
    email: ("new" + (i|tostring) + "@" + $pfx + "-new" + (i|tostring) + ".example")
  };
  {projectId:$pid,
   candidates: [range(0;20)] | map(
     if . < 5 then emailDup(.)
     elif . < 10 then formDup(. - 5)
     else freshCand(. - 10)
     end)
  }')"
F_CHECK_RESP="$(api POST /api/prospects/check-dedup "$F_CHECK_BODY")"

F_FRESH_COUNT="$(echo "$F_CHECK_RESP"   | jq '[.decisions[] | select(.kind == "fresh")] | length')"
F_EMAIL_DUP="$(echo "$F_CHECK_RESP"     | jq '[.decisions[] | select(.reason == "email_duplicate")] | length')"
F_FORM_DUP="$(echo "$F_CHECK_RESP"      | jq '[.decisions[] | select(.reason == "form_url_duplicate")] | length')"
assert_eq "F check-dedup fresh=10"           "$F_FRESH_COUNT" "10"
assert_eq "F check-dedup email_duplicate=5"  "$F_EMAIL_DUP"   "5"
assert_eq "F check-dedup form_url_dup=5"     "$F_FORM_DUP"    "5"

# Now post the same 20 candidates through /prospects/batch with the extra
# fields the write path requires. The skippedDetails reason breakdown must
# match the read-only check-dedup decisions, and `inserted` must equal the
# fresh count. This is the parity invariant that Phase 1.5 relies on.
F_BATCH_BODY="$(jq -nc --arg pid "$F_PROJECT" --arg pfx "$F_PREFIX" '
  def emailDup(i): {
    organizationDomain: ($pfx + "-e" + (i|tostring) + ".example"),
    organizationName: ("DupE" + (i|tostring)),
    organizationWebsiteUrl: ("https://" + $pfx + "-e" + (i|tostring) + ".example"),
    name: ("DupPemail" + (i|tostring)),
    overview: "dup",
    websiteUrl: ("https://" + $pfx + "-e" + (i|tostring) + ".example/dup"),
    email: ("p" + (i|tostring) + "@" + $pfx + "-e" + (i|tostring) + ".example"),
    matchReason: "dup"
  };
  def formDup(i): {
    organizationDomain: ($pfx + "-fm" + (i|tostring) + ".example"),
    organizationName: ("DupF" + (i|tostring)),
    organizationWebsiteUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example"),
    name: ("DupPform" + (i|tostring)),
    overview: "dup",
    websiteUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example/dup"),
    contactFormUrl: ("https://" + $pfx + "-fm" + (i|tostring) + ".example/contact"),
    matchReason: "dup"
  };
  def freshP(i): {
    organizationDomain: ($pfx + "-new" + (i|tostring) + ".example"),
    organizationName: ("NewOrg" + (i|tostring)),
    organizationWebsiteUrl: ("https://" + $pfx + "-new" + (i|tostring) + ".example"),
    name: ("NewP" + (i|tostring)),
    overview: "new",
    websiteUrl: ("https://" + $pfx + "-new" + (i|tostring) + ".example/p"),
    email: ("new" + (i|tostring) + "@" + $pfx + "-new" + (i|tostring) + ".example"),
    matchReason: "new"
  };
  {projectId:$pid,
   prospects: [range(0;20)] | map(
     if . < 5 then emailDup(.)
     elif . < 10 then formDup(. - 5)
     else freshP(. - 10)
     end)
  }')"
F_BATCH_RESP="$(api POST /api/prospects/batch "$F_BATCH_BODY")"
assert_eq "F batch inserted=10"          "$(echo "$F_BATCH_RESP" | jq -r .inserted)" "10"
assert_eq "F batch skipped=10"           "$(echo "$F_BATCH_RESP" | jq -r .skipped)"  "10"
assert_eq "F batch email_duplicate=5"    "$(echo "$F_BATCH_RESP" | jq '[.skippedDetails[] | select(.reason == "email_duplicate")] | length')" "5"
assert_eq "F batch form_url_duplicate=5" "$(echo "$F_BATCH_RESP" | jq '[.skippedDetails[] | select(.reason == "form_url_duplicate")] | length')" "5"

step "Test G: candidate cap — 100 OK, 101 → 400"
G_BODY_100="$(jq -nc --arg pfx "$RUN_TAG-cap" '
  {candidates: [range(0;100)] | map({
    organizationDomain: ($pfx + "-" + (.|tostring) + ".example"),
    email: ("c" + (.|tostring) + "@" + $pfx + "-" + (.|tostring) + ".example")
  })}')"
G_RESP_100="$(api POST /api/prospects/check-dedup "$G_BODY_100")"
assert_eq "G 100 candidates → 100 decisions" \
  "$(echo "$G_RESP_100" | jq '.decisions | length')" "100"

G_STATUS_101="$(jq -nc --arg pfx "$RUN_TAG-cap" '
  {candidates: [range(0;101)] | map({
    organizationDomain: ($pfx + "-" + (.|tostring) + ".example"),
    email: ("c" + (.|tostring) + "@" + $pfx + "-" + (.|tostring) + ".example")
  })}' | curl -sS -o /dev/null -w '%{http_code}' \
    -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    -d @- "$API_URL/api/prospects/check-dedup")"
assert_eq "G 101 candidates → 400" "$G_STATUS_101" "400"

step "cleanup"
if [[ "$SKIP_CLEANUP" == "1" ]]; then
  say "SKIP_CLEANUP=1 — leaving project $PROJECT_ID + parity project $F_PROJECT and seed prospects in place"
else
  DEL_RESP="$(api DELETE "/api/projects/$PROJECT_ID")"
  assert_eq "project deleted" "$(echo "$DEL_RESP" | jq -r '.deleted')" "$PROJECT_ID"
  if [[ -n "${F_PROJECT:-}" && "$F_PROJECT" != "null" ]]; then
    DEL_RESP_F="$(api DELETE "/api/projects/$F_PROJECT")"
    assert_eq "parity project deleted" "$(echo "$DEL_RESP_F" | jq -r '.deleted')" "$F_PROJECT"
  fi
  # Prospects + organizations are tenant-scoped — drop the test rows by tag.
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -q <<SQL >/dev/null
DELETE FROM prospects WHERE organization_id IN (
  SELECT id FROM organizations WHERE domain LIKE '${RUN_TAG}%'
);
DELETE FROM organizations WHERE domain LIKE '${RUN_TAG}%';
SQL
  say "test prospects + organizations purged by tag $RUN_TAG"
fi

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 2
