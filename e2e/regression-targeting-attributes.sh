#!/usr/bin/env bash
# Regression for closed-loop Phase A (targeting attributes + observation axes):
#
#   A. employee_band is INSERT-only through add_prospects — a dedup-matched
#      org keeps its band; explicit change goes through PATCH /organizations.
#   B. industry is validated row-level against the controlled vocabulary:
#      add_prospects skips the bad row (reason unknown_industry, batch stays
#      partial-success), CSV import reports it in errorDetails; 'Other' and
#      whitespace-padded vocabulary values pass.
#   C. GET /projects/:id/stats carries the three observation axes —
#      industryResponseRate (coarse fold: two fine software labels land in
#      one software_tech bucket), sizeResponseRate, countryResponseRate
#      (prospect.country overrides organization.country) — and all three
#      count mature sends only (a fresh send is invisible until it is older
#      than the reward window).
#
# Seed: 4 prospects/orgs, 4 'sent' email logs on a dedicated dummy identity.
# L1-L3 are backdated 15 days (mature, rewardWindowDays default 14); L4 stays
# fresh. L1/L3 get a message_id (threadable); L1 draws a reply, L3 a bounce.
#
#   axis           expected buckets (mature sends only)
#   industry       software_tech {total 2, responses 1}   <- P1 'B2B SaaS' + P2 'AI / ML'
#                  vertical_tech {total 1, bounces 1, bounceRate 100}  <- P3 'FinTech'
#   size           11-50 {total 2, responses 1}, 201+ {total 1, bounces 1}
#                  and NO 'unknown' bucket (L4's org is 'unknown' but immature)
#   country        US {total 2}, JP {total 1}  <- P2's prospect-level JP wins over org US
#
# Curl-only, no Claude session. Cleans up.
#
# Usage:
#   ./e2e/regression-targeting-attributes.sh
#   SKIP_CLEANUP=1 ./e2e/regression-targeting-attributes.sh
#
# Exit status:
#   0 — all assertions passed
#   1 — a setup or HTTP step failed
#   2 — at least one assertion mismatch

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_URL="${API_URL:-http://localhost:8787}"
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"

RUN_TAG="e2e-attr-$(date +%s)"
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

# mkseed tag industry-or-empty band-or-empty country
mkseed() {
  local tag="$1" industry="$2" band="$3" country="$4"
  local dom="$RUN_TAG-$tag.example"
  jq -nc --arg d "$dom" --arg e "contact@$dom" --arg n "P-$tag" \
    --arg i "$industry" --arg b "$band" --arg c "$country" \
    '{organizationDomain:$d, organizationName:("Org "+$d), organizationWebsiteUrl:("https://"+$d),
      country:$c, countrySource:"manual",
      name:$n, overview:"seed", websiteUrl:("https://"+$d+"/about"), email:$e, matchReason:"seed"}
     + (if $i != "" then {industry:$i} else {} end)
     + (if $b != "" then {employeeBand:$b} else {} end)'
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

# Dedicated dummy identity so the mailbox ramp cap never depends on the local
# fallback identity's real send history (same pattern as regression-bounce-stats).
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
  psql_local "DELETE FROM prospects WHERE tenant_id = '$TENANT_ID' AND email LIKE '%@$RUN_TAG-%';" > /dev/null || true
  psql_local "DELETE FROM organizations WHERE tenant_id = '$TENANT_ID' AND domain LIKE '$RUN_TAG-%';" > /dev/null || true
  say "dropped run-tagged rows"
  exit "$rc"
}
trap restore_and_exit EXIT

step "setup: compliance ready + project on the dummy identity"
api PUT /api/tenant-settings '{"legalName":"E2E Test Corp","physicalAddress":"123 Test Lane, Test City, CA 94000","defaultSenderCountry":"US"}' > /dev/null
say "tenant compliance set"

PROJECT_ID="$(api POST /api/projects "$(jq -nc --arg n "$PROJECT_NAME" '{name:$n}')" | jq -r '.id // ""')"
[[ -n "$PROJECT_ID" ]] || { echo "create-project failed" >&2; exit 1; }
say "project_id=$PROJECT_ID"

ASSIGN_RESP="$(api PUT "/api/projects/$PROJECT_ID/settings" "$(jq -nc --arg i "$IDENTITY_ID" '{sendingIdentityId:$i}')")"
assert_eq "project assigned to dummy identity" "$(echo "$ASSIGN_RESP" | jq -r '.sendingIdentityId // ""')" "$IDENTITY_ID"

step "Test A: employee_band bootstrap, INSERT-only on dedup match, explicit PATCH"
# P1 org registers with band 11-50.
SEED1="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson a "$(mkseed a 'B2B SaaS' '11-50' US)" '{projectId:$pid, prospects:[$a]}')")"
assert_eq "P1 inserted" "$(echo "$SEED1" | jq -r '.inserted')" "1"

ORG_A="$(api GET "/api/organizations?q=$RUN_TAG-a.example" | jq -c '.organizations[0] // empty')"
ORG_A_ID="$(echo "$ORG_A" | jq -r '.id // ""')"
assert_eq "org A band bootstrapped" "$(echo "$ORG_A" | jq -r '.employeeBand')" "11-50"

# Second prospect on the same org domain (tenant-only: the in-project domain
# dedup would skip it) supplying a different band — the existing org wins.
SEED1B="$(api POST /api/prospects/batch "$(jq -nc \
  --argjson a "$(mkseed a '' '201+' US | jq -c '.email = "second@'"$RUN_TAG"'-a.example" | .name = "P-a2" | del(.matchReason)')" \
  '{prospects:[$a]}')")"
assert_eq "same-domain second prospect inserted" "$(echo "$SEED1B" | jq -r '.inserted')" "1"
assert_eq "org A band unchanged after dedup-matched insert (INSERT-only)" \
  "$(api GET "/api/organizations?q=$RUN_TAG-a.example" | jq -r '.organizations[0].employeeBand')" "11-50"

PATCHED="$(api PATCH "/api/organizations/$ORG_A_ID" '{"employeeBand":"51-200"}')"
assert_eq "PATCH updates band explicitly" "$(echo "$PATCHED" | jq -r '.organization.employeeBand')" "51-200"
api PATCH "/api/organizations/$ORG_A_ID" '{"employeeBand":"11-50"}' > /dev/null

step "Test B: industry vocabulary is enforced row-level"
# One valid catch-all row, one padded-vocabulary row, one free-form row: the
# batch stays partial-success and only the free-form row is skipped.
BATCH_B="$(api POST /api/prospects/batch "$(jq -nc \
  --argjson ok1 "$(mkseed v1 'Other' '' US | jq -c 'del(.matchReason)')" \
  --argjson ok2 "$(mkseed v2 '  FinTech  ' '' US | jq -c 'del(.matchReason)')" \
  --argjson bad "$(mkseed v3 'Underwater Basket Weaving' '' US | jq -c 'del(.matchReason)')" \
  '{prospects:[$ok1,$ok2,$bad]}')")"
assert_eq "valid rows inserted" "$(echo "$BATCH_B" | jq -r '.inserted')" "2"
assert_eq "free-form row skipped" "$(echo "$BATCH_B" | jq -r '.skipped')" "1"
assert_eq "skip reason unknown_industry" "$(echo "$BATCH_B" | jq -r '.skippedDetails[0].reason')" "unknown_industry"
assert_eq "skip detail names the vocabulary doc" \
  "$(echo "$BATCH_B" | jq -r '.skippedDetails[0].detail' | grep -c 'tpl_industries')" "1"
assert_eq "padded vocabulary value stored canonically trimmed" \
  "$(psql_local "SELECT industry FROM prospects WHERE tenant_id='$TENANT_ID' AND email='contact@$RUN_TAG-v2.example';")" "FinTech"

CSV_TEXT="organizationDomain,organizationName,organizationWebsiteUrl,name,overview,websiteUrl,email,industry
$RUN_TAG-c1.example,Org C1,https://$RUN_TAG-c1.example,P-c1,seed,https://$RUN_TAG-c1.example/about,contact@$RUN_TAG-c1.example,B2B SaaS
$RUN_TAG-c2.example,Org C2,https://$RUN_TAG-c2.example,P-c2,seed,https://$RUN_TAG-c2.example/about,contact@$RUN_TAG-c2.example,Basket Weaving"
CSV_RESP="$(api POST /api/prospects/import "$(jq -nc --arg t "$CSV_TEXT" '{csvText:$t}')")"
assert_eq "CSV valid row inserted" "$(echo "$CSV_RESP" | jq -r '.inserted')" "1"
assert_eq "CSV bad-industry row errors" "$(echo "$CSV_RESP" | jq -r '.errors')" "1"
assert_eq "CSV error names the vocabulary doc" \
  "$(echo "$CSV_RESP" | jq -r '.errorDetails[0].error' | grep -c 'tpl_industries')" "1"

step "seed sends for the observation axes"
# P2: second software fine label (coarse fold with P1). P3: vertical_tech +
# 201+, will bounce. P4: no industry / band / stays fresh (maturity-window
# probe). All register as US; P2's prospect-level country is PATCHed to JP
# below — registering with country JP would also bootstrap the ORG as JP,
# and the COALESCE precedence assertion needs org US / prospect JP.
SEED2="$(api POST /api/prospects/batch "$(jq -nc --arg pid "$PROJECT_ID" \
  --argjson b "$(mkseed b 'AI / ML' '11-50' US)" \
  --argjson c "$(mkseed c 'FinTech' '201+' US)" \
  --argjson d "$(mkseed d '' '' US)" \
  '{projectId:$pid, prospects:[$b,$c,$d]}')")"
assert_eq "P2-P4 inserted" "$(echo "$SEED2" | jq -r '.inserted')" "3"

LIST_RESP="$(api GET "/api/projects/$PROJECT_ID/prospects?limit=200")"
pid_of() { echo "$LIST_RESP" | jq -r --arg e "contact@$RUN_TAG-$1.example" '.prospects[]? | select(.email == $e) | .prospectId' | head -1; }
P_A="$(pid_of a)"; P_B="$(pid_of b)"; P_C="$(pid_of c)"; P_D="$(pid_of d)"
[[ -n "$P_A" && -n "$P_B" && -n "$P_C" && -n "$P_D" ]] || { echo "could not resolve prospect ids" >&2; exit 1; }

api PATCH "/api/prospects/$P_B" '{"country":"JP","countrySource":"manual"}' > /dev/null
assert_eq "P2 prospect country JP over org US" \
  "$(psql_local "SELECT p.country || '/' || o.country FROM prospects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = $P_B;")" "JP/US"

L1="$(send_email "$P_A")"; L2="$(send_email "$P_B")"; L3="$(send_email "$P_C")"; L4="$(send_email "$P_D")"
[[ -n "$L1" && -n "$L2" && -n "$L3" && -n "$L4" ]] || { echo "send seeding failed: L1=$L1 L2=$L2 L3=$L3 L4=$L4" >&2; exit 1; }

# Mature L1-L3 past the 14-day reward window; L4 stays fresh. L1/L3 become
# threadable so the bounce-eligible denominator is exercised.
psql_local "UPDATE outreach_logs SET sent_at = now() - interval '15 days' WHERE id IN ($L1,$L2,$L3);" > /dev/null
psql_local "UPDATE outreach_logs SET message_id='<$RUN_TAG-'||id||'@example.com>' WHERE id IN ($L1,$L3);" > /dev/null
record_response "$L1" reply
record_response "$L3" bounce
say "logs: mature=$L1,$L2,$L3 fresh=$L4; reply on L1, bounce on L3"

step "Test C: observation axes on GET /projects/:id/stats"
STATS="$(api GET "/api/projects/$PROJECT_ID/stats")"

SOFT="$(echo "$STATS" | jq -c '.metrics.industryResponseRate[]? | select(.industry == "software_tech") // empty')"
VERT="$(echo "$STATS" | jq -c '.metrics.industryResponseRate[]? | select(.industry == "vertical_tech") // empty')"
assert_eq "software_tech folds two fine labels: total=2" "$(echo "$SOFT" | jq -r '.total')" "2"
assert_eq "software_tech responses=1" "$(echo "$SOFT" | jq -r '.responses')" "1"
assert_eq "software_tech rate=50" "$(echo "$SOFT" | jq -r '.rate')" "50"
assert_eq "vertical_tech total=1" "$(echo "$VERT" | jq -r '.total')" "1"
assert_eq "vertical_tech responses=0 (bounce is not a reply)" "$(echo "$VERT" | jq -r '.responses')" "0"
assert_eq "vertical_tech bounces=1" "$(echo "$VERT" | jq -r '.bounces')" "1"
assert_eq "vertical_tech bounceRate=100 (threadable denominator)" "$(echo "$VERT" | jq -r '.bounceRate')" "100"
assert_eq "no 'other' industry bucket (fresh L4 is immature)" \
  "$(echo "$STATS" | jq -r '[.metrics.industryResponseRate[]? | select(.industry == "other")] | length')" "0"

SMALL="$(echo "$STATS" | jq -c '.metrics.sizeResponseRate[]? | select(.employeeBand == "11-50") // empty')"
BIG="$(echo "$STATS" | jq -c '.metrics.sizeResponseRate[]? | select(.employeeBand == "201+") // empty')"
assert_eq "band 11-50 total=2" "$(echo "$SMALL" | jq -r '.total')" "2"
assert_eq "band 11-50 responses=1" "$(echo "$SMALL" | jq -r '.responses')" "1"
assert_eq "band 201+ bounces=1" "$(echo "$BIG" | jq -r '.bounces')" "1"
assert_eq "no 'unknown' band bucket (fresh L4 is immature)" \
  "$(echo "$STATS" | jq -r '[.metrics.sizeResponseRate[]? | select(.employeeBand == "unknown")] | length')" "0"

US="$(echo "$STATS" | jq -c '.metrics.countryResponseRate[]? | select(.country == "US") // empty')"
JP="$(echo "$STATS" | jq -c '.metrics.countryResponseRate[]? | select(.country == "JP") // empty')"
assert_eq "US total=2 (L1,L3)" "$(echo "$US" | jq -r '.total')" "2"
assert_eq "US responses=1" "$(echo "$US" | jq -r '.responses')" "1"
assert_eq "JP total=1 (prospect country overrides org US)" "$(echo "$JP" | jq -r '.total')" "1"

step "summary"
echo "  PASS=$PASS  FAIL=$FAIL" >&2
if [[ "$FAIL" -gt 0 ]]; then
  exit 2
fi
exit 0
