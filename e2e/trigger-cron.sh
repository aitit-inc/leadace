#!/usr/bin/env bash
# Fire the API Worker's scheduled (cron) handler against the local stack.
#
# Cloudflare cron triggers don't fire automatically under `wrangler dev`.
# `npm run dev:api` starts the Worker with `--test-scheduled`, which exposes
# /__scheduled; this script just curls it. Watch the API Worker terminal for
# `[scheduled] org-signals refresh` log lines.
#
# Usage:
#   ./e2e/trigger-cron.sh                       # default cron spec "0 3 * * *"
#   ./e2e/trigger-cron.sh "*/5 * * * *"         # custom cron string (URL-encoded)
#
# Env overrides:
#   API_HOST      base URL of the local API Worker (default http://localhost:8787)

set -uo pipefail

API_HOST="${API_HOST:-http://localhost:8787}"
cron_spec="${1:-0 3 * * *}"

# URL-encode spaces only — the cron spec uses '*' which is safe in a query
# string. Bash builtin substitution is enough; no curl --data-urlencode needed
# because /__scheduled reads from the query string, not the body.
encoded_cron="${cron_spec// /+}"

url="${API_HOST}/__scheduled?cron=${encoded_cron}"

echo "Firing scheduled handler: ${url}"
status=$(curl --silent --show-error --output /dev/stderr --write-out '%{http_code}' \
  --max-time 30 "${url}")

if [[ "${status}" != "200" ]]; then
  echo "" >&2
  echo "FAIL: /__scheduled returned HTTP ${status}." >&2
  echo "Check that the API Worker is running with --test-scheduled" >&2
  echo "(npm run dev:api wires it up)." >&2
  exit 1
fi

echo ""
echo "OK: scheduled handler fired. Inspect the API Worker terminal for log output."
