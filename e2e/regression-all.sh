#!/usr/bin/env bash
# Run every curl-only regression in sequence (no Claude session, no Anthropic
# budget). The onboarding-chain smoke (./e2e/smoke.sh) is intentionally NOT
# included — it drives the Claude CLI and needs a live MCP OAuth grant; run it
# separately.
#
# Each child script mints its own JWT, self-checks API health, runs its
# assertions against the local stack, and cleans up after itself. This wrapper
# only sequences them and aggregates pass/fail, so one command covers the whole
# curl-only gate.
#
# Usage:
#   ./e2e/regression-all.sh
#   SKIP_CLEANUP=1 ./e2e/regression-all.sh   # forwarded to each child suite
#
# Exit status:
#   0 — all suites passed
#   1 — at least one suite failed (see the per-suite summary)

set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SUITES=(
  regression-project-ref
  regression-outbound
  regression-build-list-dedup
  regression-skip-reachable
  regression-email-deliverability
  regression-unsubscribe
  regression-import-dnc
  regression-record-outreach
  regression-update-outreach-status
  regression-record-with-inquiry
  regression-draft-send
  regression-inflight-reachable
  regression-followup-sequence
  regression-mailbox-warmup
  regression-sending-identities
  regression-prospect-update-channel
  regression-record-evaluation-priority
  regression-prospect-delete
  regression-rejection-cycle
  regression-bounce-stats
  regression-inquiry-unsubscribe
  regression-decision-maker-pointer
  regression-tenant-isolation
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

printf '\n=============== regression-all summary ===============\n' >&2
for r in "${RESULTS[@]}"; do printf '  %s\n' "$r" >&2; done
if [[ "$fail" -eq 0 ]]; then
  printf '  ALL SUITES PASSED\n' >&2
else
  printf '  SOME SUITES FAILED\n' >&2
fi
exit "$fail"
