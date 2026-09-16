#!/usr/bin/env bash
#
# VM provisioning for a Claude Code cloud session (claude.ai/code): paste this
# file into the environment's "Setup script" field. It runs once as root before
# Claude Code launches and the filesystem is snapshotted afterwards, so node 24,
# the Supabase CLI and the Supabase images are on disk in every later session.
#
# A snapshot keeps files, never processes: bringing the stack up is
# scripts/cloud-bootstrap.sh, which runs per session.
#
# Two constraints this script is written around
# (https://code.claude.com/docs/en/cloud-environments):
#   - a non-zero exit makes the session fail to start, so every step degrades
#     to a warning and the script always exits 0
#   - it should finish within ~5 minutes, or no snapshot is taken at all, so
#     every step is capped and the warm pull gets what is left of the budget

set -u

DEADLINE=$(( $(date +%s) + 270 ))
remaining() { echo $(( DEADLINE - $(date +%s) )); }

log() { printf '[cloud-setup] %s\n' "$*"; }

install_node24() {
  if node --version 2>/dev/null | grep -q '^v24\.'; then
    log "node $(node --version) already on PATH"
    return
  fi
  if N_PREFIX=/usr/local timeout 90 npm install -g n >/dev/null 2>&1 \
    && N_PREFIX=/usr/local timeout 90 n 24 >/dev/null 2>&1; then
    log "node $(/usr/local/bin/node --version 2>/dev/null) installed at /usr/local/bin"
  else
    log "WARN node 24 install failed — sessions stay on $(node --version 2>/dev/null)"
  fi
}

install_supabase_cli() {
  if command -v supabase >/dev/null 2>&1; then
    log "supabase CLI $(supabase --version 2>/dev/null) already present"
    return
  fi
  if timeout 90 npm install -g supabase >/dev/null 2>&1; then
    log "supabase CLI $(supabase --version 2>/dev/null) installed"
  else
    log "WARN supabase CLI install failed — cloud-bootstrap.sh falls back to npx"
  fi
}

start_docker() {
  if docker info >/dev/null 2>&1; then
    log "docker already running"
    return 0
  fi
  if ! command -v dockerd >/dev/null 2>&1; then
    log "WARN dockerd not installed on this image"
    return 1
  fi
  (dockerd >/tmp/dockerd.log 2>&1 &)
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && { log "docker started"; return 0; }
    sleep 1
  done
  log "WARN docker did not come up (see /tmp/dockerd.log)"
  return 1
}

# `supabase start` in a throwaway project pulls every image the real stack
# needs; the snapshot keeps them, so the per-session start is a container boot
# rather than a multi-GB pull. A postgres major pinned differently in the repo's
# config.toml is pulled by the first cloud-bootstrap.sh run.
#
# The cap protects the snapshot: overrunning the environment's ~5-minute budget
# means no cache is built at all, and then every session repeats this script.
# A pull cut short still leaves the images it finished on disk.
warm_supabase_images() {
  command -v supabase >/dev/null 2>&1 || return 0
  budget="$(remaining)"
  [ "$budget" -gt 60 ] || { log "WARN no budget left for the warm pull"; return 0; }
  [ "$budget" -gt 150 ] && budget=150
  mkdir -p /tmp/supabase-warm && cd /tmp/supabase-warm || return 0
  timeout 30 supabase init >/dev/null 2>&1 </dev/null
  # The generated config reads these; a snapshot outlives the container they
  # would land in, so warm up without them.
  if env -u OPENAI_API_KEY -u GEMINI_API_KEY timeout "$budget" supabase start >/dev/null 2>&1; then
    log "supabase images pulled into the snapshot"
  else
    log "WARN warm pull incomplete — cloud-bootstrap.sh pulls what is missing"
  fi
  timeout 60 supabase stop --no-backup >/dev/null 2>&1 \
    || log "WARN warm-up containers are still up — check docker ps"
}

# The daemon runs alongside the installs; the two npm installs stay sequential
# because they write the same global prefix.
start_docker &
docker_pid=$!

install_node24
install_supabase_cli

wait "$docker_pid" && warm_supabase_images

log "done"
exit 0
