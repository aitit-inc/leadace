#!/usr/bin/env bash
# Mint an HMAC-SHA256 unsubscribe token for the local stack so curl-based E2E
# tests can hit the public /api/unsubscribe/:token routes the same way an
# outbound email's footer link would.
#
# Token format mirrors backend/src/auth/unsubscribe-token.ts exactly:
#   `${prospectId}.${tenantId}.${sig}`
#   sig = base64url(HMAC-SHA256(secret, `${prospectId}:${tenantId}`))
# The secret is the shared UNSUBSCRIBE_TOKEN_SECRET from backend/.dev.vars.
# Production uses a different secret, so a token minted here only verifies
# against the local Worker by construction.
#
# Usage:
#   ./e2e/sign-unsubscribe-token.sh --prospect-id 42 --tenant-id <nanoid>
#   # tamper modes (for negative tests):
#   ./e2e/sign-unsubscribe-token.sh --prospect-id 42 --tenant-id T --bad-sig
#
# Output: the token, single line on stdout.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_VARS="$REPO_ROOT/backend/.dev.vars"

PROSPECT_ID=""
TENANT_ID=""
BAD_SIG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prospect-id) PROSPECT_ID="$2"; shift 2 ;;
    --tenant-id)   TENANT_ID="$2"; shift 2 ;;
    --bad-sig)     BAD_SIG=1; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PROSPECT_ID" || -z "$TENANT_ID" ]]; then
  echo "usage: $0 --prospect-id <int> --tenant-id <nanoid> [--bad-sig]" >&2
  exit 2
fi

if [[ ! -f "$DEV_VARS" ]]; then
  echo "missing $DEV_VARS — start the local API Worker once to generate" >&2
  exit 1
fi

SECRET="$(grep -E '^UNSUBSCRIBE_TOKEN_SECRET=' "$DEV_VARS" | head -1 | cut -d= -f2- | tr -d '"')"
if [[ -z "$SECRET" ]]; then
  echo "UNSUBSCRIBE_TOKEN_SECRET not found in $DEV_VARS" >&2
  exit 1
fi

SECRET="$SECRET" PROSPECT_ID="$PROSPECT_ID" TENANT_ID="$TENANT_ID" BAD_SIG="$BAD_SIG" node -e '
const crypto = require("crypto");
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const prospectId = process.env.PROSPECT_ID;
const tenantId = process.env.TENANT_ID;
const message = `${prospectId}:${tenantId}`;
let sig = b64url(crypto.createHmac("sha256", process.env.SECRET).update(message).digest());
if (process.env.BAD_SIG === "1") {
  // Flip the first character to a different base64url char so verification fails.
  const first = sig[0] === "A" ? "B" : "A";
  sig = first + sig.slice(1);
}
process.stdout.write(`${prospectId}.${tenantId}.${sig}\n`);
'
