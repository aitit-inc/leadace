#!/usr/bin/env bash
# Boot a SECOND API Worker as the cloud edition (LEADACE_EDITION=cloud) on a
# separate port so plan-tier caps actually bind. The default dev worker
# (npm run dev:api, :8787) is self-hosted — getTenantPlan short-circuits every
# tenant to 'unlimited', so quota / plan-limit / Stripe-webhook code never
# fires there. The cloud-edition regression cluster (regression-cloud-*.sh)
# targets this worker.
#
# Run it in its own terminal (foreground, like npm run dev:api). It shares the
# local Postgres/Supabase from backend/.dev.vars via wrangler's automatic
# .dev.vars load; only the edition flag and Stripe TEST secrets are injected
# here (the Stripe secret key is a dummy — the cluster never reaches the real
# Stripe API; only checkout.session.completed would, and that path is out of
# harness scope).
#
# Usage:
#   ./e2e/cloud-edition-up.sh                  # :8789, default test secrets
#   CLOUD_PORT=8799 ./e2e/cloud-edition-up.sh  # custom port (also set API_URL for the suites)
#
# STRIPE_WEBHOOK_SECRET must match what regression-cloud-stripe-webhook.sh
# signs with (both default to whsec_e2e_test_secret).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLOUD_PORT="${CLOUD_PORT:-8789}"
CLOUD_INSPECTOR_PORT="${CLOUD_INSPECTOR_PORT:-9231}"
STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-sk_test_e2e_dummy}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-whsec_e2e_test_secret}"

echo "Starting cloud-edition API Worker on :$CLOUD_PORT (LEADACE_EDITION=cloud)" >&2
echo "  point the suites at it with: API_URL=http://localhost:$CLOUD_PORT" >&2

cd "$REPO_ROOT/backend"
exec npx wrangler dev --config wrangler.api.jsonc \
  --port "$CLOUD_PORT" --inspector-port "$CLOUD_INSPECTOR_PORT" \
  --var "LEADACE_EDITION:cloud" \
  --var "STRIPE_SECRET_KEY:$STRIPE_SECRET_KEY" \
  --var "STRIPE_WEBHOOK_SECRET:$STRIPE_WEBHOOK_SECRET"
