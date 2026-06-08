#!/usr/bin/env bash
# Run the cloud-edition regression cluster (regression-cloud-*.sh) in sequence.
#
# These suites REQUIRE a second API Worker booted with LEADACE_EDITION=cloud
# (default :8789) — on the self-hosted dev worker (:8787) every tenant resolves
# to 'unlimited' and the quota / plan-limit / Stripe-webhook code never fires.
# That different prerequisite is why this is separate from regression-all.sh.
#
# Start the cloud worker first, in its own terminal:
#   ./e2e/cloud-edition-up.sh
# then:
#   ./e2e/regression-cloud-all.sh
#   SKIP_CLEANUP=1 ./e2e/regression-cloud-all.sh   # forwarded to each child suite
#
# Each child provisions its OWN throwaway tenant and cleans it up, so the suites
# don't interfere and leave no residue.
#
# Exit status:
#   0 — all suites passed
#   1 — the cloud worker isn't running, or at least one suite failed

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
API_URL="${API_URL:-http://localhost:8789}"; export API_URL
SKIP_CLEANUP="${SKIP_CLEANUP:-0}"; export SKIP_CLEANUP

# Edition probe: cloud 400s POST /api/stripe/webhook (passes the edition guard,
# rejects the missing signature); self-hosted 404s it.
code="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$API_URL/api/stripe/webhook" 2>/dev/null || true)"
if [[ "$code" != "400" ]]; then
  echo "Cloud-edition worker not detected at $API_URL (edition probe got '$code', want 400)." >&2
  echo "Start it first, in its own terminal:  ./e2e/cloud-edition-up.sh" >&2
  exit 1
fi

SUITES=(
  regression-cloud-quota
  regression-cloud-limits
  regression-cloud-stripe-webhook
  regression-cloud-inquiry-quota
)

fail=0
declare -a RESULTS=()

for s in "${SUITES[@]}"; do
  printf '\n############### %s ###############\n' "$s" >&2
  "$HERE/$s.sh"
  rc=$?
  if [[ "$rc" -eq 0 ]]; then
    RESULTS+=("PASS  $s")
  else
    RESULTS+=("FAIL  $s (exit $rc)")
    fail=1
  fi
done

printf '\n=============== regression-cloud-all summary ===============\n' >&2
for r in "${RESULTS[@]}"; do printf '  %s\n' "$r" >&2; done
if [[ "$fail" -eq 0 ]]; then
  printf '  ALL CLOUD SUITES PASSED\n' >&2
else
  printf '  SOME CLOUD SUITES FAILED\n' >&2
fi
exit "$fail"
