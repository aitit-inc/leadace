#!/usr/bin/env bash
# Mint a Supabase-shape HS256 JWT for the local stack so curl-based E2E
# tests can hit the API Worker as an authenticated user.
#
# The local API Worker accepts HS256 with the shared secret from
# backend/.dev.vars (`SUPABASE_JWT_SECRET`), falls back from the JWKS path.
# Production rejects HS256 with a fake secret, so this stays local-only by
# construction.
#
# Usage:
#   ./e2e/mint-jwt.sh --user-id 9818f126-...      # explicit user id
#   ./e2e/mint-jwt.sh --email leo.uno@example.com # resolve via auth.users
#   ./e2e/mint-jwt.sh                              # default: first row in auth.users
#   ./e2e/mint-jwt.sh --aud mcp                    # MCP-shaped token (aud=mcp → caller 'mcp')
#
# Output: the bearer token, single line on stdout. Wrap as needed:
#   TOKEN="$(./e2e/mint-jwt.sh --email ...)"
#   curl -H "Authorization: Bearer $TOKEN" http://localhost:8787/me/plan

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_VARS="$REPO_ROOT/backend/.dev.vars"

EMAIL=""
USER_ID=""
TTL_SECONDS="${TTL_SECONDS:-3600}"
AUD="authenticated"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)    EMAIL="$2"; shift 2 ;;
    --user-id)  USER_ID="$2"; shift 2 ;;
    --ttl)      TTL_SECONDS="$2"; shift 2 ;;
    --aud)      AUD="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "$DEV_VARS" ]]; then
  echo "missing $DEV_VARS — start the local API Worker once to generate" >&2
  exit 1
fi

SECRET="$(grep -E '^SUPABASE_JWT_SECRET=' "$DEV_VARS" | head -1 | cut -d= -f2- | tr -d '"')"
if [[ -z "$SECRET" ]]; then
  echo "SUPABASE_JWT_SECRET not found in $DEV_VARS" >&2
  exit 1
fi

if [[ -n "$EMAIL" && -n "$USER_ID" ]]; then
  echo "pass either --email or --user-id, not both" >&2
  exit 2
fi

if [[ -n "$EMAIL" ]]; then
  USER_ID="$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
    "SELECT id FROM auth.users WHERE email = '$EMAIL' LIMIT 1;" 2>/dev/null || true)"
  if [[ -z "$USER_ID" ]]; then
    echo "no auth.users row for email=$EMAIL" >&2
    exit 1
  fi
fi

if [[ -z "$USER_ID" ]]; then
  USER_ID="$(PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -tAc \
    "SELECT id FROM auth.users ORDER BY created_at LIMIT 1;" 2>/dev/null || true)"
  if [[ -z "$USER_ID" ]]; then
    echo "no auth.users rows; sign in once via the frontend or seed a user first" >&2
    exit 1
  fi
fi

SECRET="$SECRET" USER_ID="$USER_ID" TTL_SECONDS="$TTL_SECONDS" AUD="$AUD" node -e '
const crypto = require("crypto");
const b64 = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const now = Math.floor(Date.now() / 1000);
const header = { alg: "HS256", typ: "JWT" };
const payload = {
  sub: process.env.USER_ID,
  aud: process.env.AUD,
  role: "authenticated",
  iat: now,
  exp: now + Number(process.env.TTL_SECONDS),
};
const headerB64 = b64(JSON.stringify(header));
const payloadB64 = b64(JSON.stringify(payload));
const signing = `${headerB64}.${payloadB64}`;
const sig = crypto.createHmac("sha256", process.env.SECRET).update(signing).digest();
process.stdout.write(`${signing}.${b64(sig)}\n`);
'
