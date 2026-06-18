#!/usr/bin/env bash
#
# One-command local dev stack: Supabase (CLI) + migrate + seed + API/MCP/frontend.
#
#   scripts/dev.sh        # up (default). Ctrl-C stops the dev servers.
#   scripts/dev.sh down   # stop Supabase (the servers stop on Ctrl-C)
#
# App ports are overridable via dev.ports.env (see dev.ports.env.example).
# Supabase stays on its CLI; the Workers run natively under wrangler.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

supa() { "$REPO_ROOT/scripts/supabase-local.sh" "$@"; }

if [ "${1:-up}" = "down" ]; then
  echo "==> Stopping Supabase"
  supa stop
  exit $?
fi

if [ "${1:-up}" != "up" ]; then
  echo "dev.sh: unknown command '$1' (expected 'up' or 'down')" >&2
  exit 2
fi

# --- pre-flight -------------------------------------------------------------
if [ ! -f backend/.dev.vars ]; then
  echo "ERROR: backend/.dev.vars is missing — cp backend/.dev.vars.example backend/.dev.vars" >&2
  exit 1
fi
if [ ! -f frontend/.env ]; then
  echo "ERROR: frontend/.env is missing — cp frontend/.env.example frontend/.env" >&2
  exit 1
fi
# npm ci (not install) so the lockfile is never pruned — see README "Updating dependencies".
for pkg in backend frontend; do
  [ -d "$pkg/node_modules" ] || { echo "==> Installing $pkg deps (npm ci)"; npm --prefix "$pkg" ci; }
done
if [ -z "${SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID:-}" ]; then
  echo "WARN: SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID unset — local Google sign-in won't work (see .envrc.example)."
fi

# --- ports (overridable; unset => standard defaults) ------------------------
[ -f dev.ports.env ] && . ./dev.ports.env
FRONTEND_PORT="${LEADACE_FRONTEND_PORT:-5173}"
API_PORT="${LEADACE_API_PORT:-8787}"
MCP_PORT="${LEADACE_MCP_PORT:-8788}"
# Reject leading zeros too: the arithmetic below would read them as octal.
for p in "$FRONTEND_PORT" "$API_PORT" "$MCP_PORT"; do
  case "$p" in 0[0-9]*|*[!0-9]*|'') echo "ERROR: port '$p' must be digits, no leading zero" >&2; exit 1;; esac
done
# Inspector ports: keep 9229/9230 at defaults, shift alongside a custom worker port.
API_INSPECTOR="${LEADACE_API_INSPECTOR_PORT:-$(( API_PORT == 8787 ? 9229 : API_PORT + 1000 ))}"
MCP_INSPECTOR="${LEADACE_MCP_INSPECTOR_PORT:-$(( MCP_PORT == 8788 ? 9230 : MCP_PORT + 1000 ))}"
dupe=$(printf '%s\n' "$FRONTEND_PORT" "$API_PORT" "$MCP_PORT" "$API_INSPECTOR" "$MCP_INSPECTOR" | sort | uniq -d | head -1)
[ -n "$dupe" ] && { echo "ERROR: port $dupe is used by more than one service; set LEADACE_*_INSPECTOR_PORT" >&2; exit 1; }

# --- Supabase ---------------------------------------------------------------
if supa status >/dev/null 2>&1; then
  echo "==> Supabase already running"
else
  echo "==> Starting Supabase (~30s on first boot)"
  supa start
fi

echo "==> Applying migrations"
npm --prefix backend run db:migrate
echo "==> Seeding master documents"
npm --prefix backend run db:seed-master-documents

# --- dev servers ------------------------------------------------------------
if [ -t 1 ]; then
  C_API=$'\033[36m'; C_MCP=$'\033[35m'; C_FE=$'\033[32m'; C_RST=$'\033[0m'
else
  C_API=''; C_MCP=''; C_FE=''; C_RST=''
fi

launch() {
  local tag=$1 color=$2 dir=$3; shift 3
  (
    cd "$REPO_ROOT/$dir" || exit 1
    "$@" 2>&1 | while IFS= read -r line; do printf '%s[%s]%s %s\n' "$color" "$tag" "$C_RST" "$line"; done
  ) &
}

# INT/TERM only — not EXIT: kill 0 hits our own group, so EXIT would self-kill on a clean exit.
cleanup() {
  trap - INT TERM
  echo
  echo "==> Stopping dev servers (Supabase stays up — \`scripts/dev.sh down\` to halt it)"
  kill 0 2>/dev/null || true
}
trap cleanup INT TERM

echo "==> Starting API (:$API_PORT), MCP (:$MCP_PORT), frontend (:$FRONTEND_PORT) — Ctrl-C to stop"
# --var / PUBLIC_* override .dev.vars / .env so a custom port stays wired.
launch api "$C_API" backend ./node_modules/.bin/wrangler dev \
  --config wrangler.api.jsonc --test-scheduled \
  --port "$API_PORT" --inspector-port "$API_INSPECTOR" \
  --var "APP_URL:http://localhost:$FRONTEND_PORT"
launch mcp "$C_MCP" backend ./node_modules/.bin/wrangler dev \
  --config wrangler.mcp.jsonc \
  --port "$MCP_PORT" --inspector-port "$MCP_INSPECTOR" \
  --var "WEB_API_URL:http://localhost:$API_PORT" \
  --var "FRONTEND_URL:http://localhost:$FRONTEND_PORT"
launch frontend "$C_FE" frontend env \
  "PUBLIC_API_URL=http://localhost:$API_PORT" \
  "PUBLIC_MCP_URL=http://localhost:$MCP_PORT" \
  ./node_modules/.bin/vite dev --port "$FRONTEND_PORT" --strictPort
wait
