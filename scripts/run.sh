#!/usr/bin/env bash
# scripts/run.sh — boot (or tear down) the telecode dev stack.
#
# Run via: make start (backend) | make start-all (everything) | make stop
#
# Services (Phase 0):
#   relay   Fastify + ws control plane   http://127.0.0.1:8080  (/healthz)
#   daemon  Claude Agent SDK supervisor  (dials out to the relay)
#   web     SvelteKit dev server         http://127.0.0.1:5173
#
# Background processes are nohup'd; PIDs + logs live in .run-state/ so `--stop`
# (and the next start) can clean them up. Every start stops stale instances and
# frees the port first, so this is safe to re-run.

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"
ui::init

RELAY_PORT=8080
WEB_PORT=5173
RELAY_WS="ws://127.0.0.1:${RELAY_PORT}/ws"
RUN_STATE=".run-state"

WANT_RELAY=1
WANT_DAEMON=1
WANT_WEB=1
DO_STOP=0

print_help() {
  cat <<EOF
Usage: scripts/run.sh [options]

Boot or tear down the telecode dev stack.

Options:
  (no flags)        Start everything (relay + daemon + web)
  --backend-only    Start relay + daemon only
  --frontend-only   Start the web dev server only
  --stop            Stop all services started by this script
  -h, --help        Show this help

Endpoints when up:
  relay   http://127.0.0.1:${RELAY_PORT}/healthz
  web     http://127.0.0.1:${WEB_PORT}
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)       print_help; exit 0 ;;
    --backend-only)  WANT_RELAY=1; WANT_DAEMON=1; WANT_WEB=0 ;;
    --frontend-only) WANT_RELAY=0; WANT_DAEMON=0; WANT_WEB=1 ;;
    --stop)          DO_STOP=1 ;;
    *)
      printf "ERROR: unknown argument: %s\n" "$1" >&2
      printf "Run with --help for usage.\n" >&2
      exit 2
      ;;
  esac
  shift
done

mkdir -p "$RUN_STATE"

# --- Helpers ----------------------------------------------------------------

# free_port PORT — kill anything listening on PORT (best-effort).
free_port() {
  local port="$1" pids
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
    fi
  fi
}

# stop_service NAME — kill the tracked PID (and its group) for NAME.
stop_service() {
  local name="$1"
  local pidfile="${RUN_STATE}/${name}.pid"
  local pid
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      pkill -P "$pid" 2>/dev/null || true # sweep any children first
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
}

# start_service NAME "command" — stop stale, then nohup-start in the background.
start_service() {
  local name="$1"
  local cmd="$2"
  local logfile="${RUN_STATE}/${name}.log"
  stop_service "$name"
  : >"$logfile"
  # `exec` inside the subshell replaces it with the real process, so the PID we
  # record is the node/vite process itself (clean to signal). nohup detaches it.
  nohup bash -c "$cmd" >"$logfile" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" >"${RUN_STATE}/${name}.pid"
  disown 2>/dev/null || true
}

# wait_http URL TIMEOUT — poll an HTTP endpoint until it answers (no sleep loop).
wait_http() {
  local url="$1" timeout="${2:-30}"
  curl -fsS --max-time "$timeout" \
    --retry "$timeout" --retry-delay 1 --retry-all-errors --retry-connrefused \
    "$url" >/dev/null 2>&1
}

# wait_log FILE NEEDLE TIMEOUT — wait until NEEDLE appears in FILE.
wait_log() {
  local file="$1" needle="$2" timeout="${3:-20}" i=0
  while [ "$i" -lt "$timeout" ]; do
    [ -f "$file" ] && grep -q "$needle" "$file" 2>/dev/null && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# --- Stop mode --------------------------------------------------------------
if [ "$DO_STOP" = "1" ]; then
  ui::banner "make stop" "Tearing down the telecode dev stack"
  ui::step 1 1 "Stopping services"
  for name in web daemon relay; do
    stop_service "$name"
    ui::ok "$name stopped"
  done
  free_port "$RELAY_PORT"
  free_port "$WEB_PORT"
  ui::summary_begin "Stop Summary"
  ui::summary_row "relay" "stopped" "ok"
  ui::summary_row "daemon" "stopped" "ok"
  ui::summary_row "web" "stopped" "ok"
  ui::summary_end
  exit 0
fi

# --- Start mode -------------------------------------------------------------
ui::banner "make start" "Booting the telecode dev stack"

# Load .env so the daemon sees ANTHROPIC_API_KEY etc.
if [ -f ".env" ]; then
  set -a; . ./.env; set +a
fi
export LOG_LEVEL="${LOG_LEVEL:-info}"

# Prerequisites.
ui::step 1 4 "Prerequisites"
command -v pnpm >/dev/null 2>&1 || ui::die "pnpm not installed" "Run 'make setup' first"
[ -d "node_modules" ] || ui::die "dependencies not installed" "Run 'make setup' first"
ui::ok "pnpm $(pnpm --version) · deps present"

RELAY_EXIT=0
DAEMON_EXIT=0
WEB_EXIT=0

# Relay.
ui::step 2 4 "Relay (http://127.0.0.1:${RELAY_PORT})"
if [ "$WANT_RELAY" = "1" ]; then
  free_port "$RELAY_PORT"
  start_service "relay" "exec env RELAY_PORT=${RELAY_PORT} node --import tsx apps/relay/src/main.ts"
  if wait_http "http://127.0.0.1:${RELAY_PORT}/healthz" 30; then
    ui::ok "relay healthy (pid $(cat ${RUN_STATE}/relay.pid))"
  else
    ui::fail "relay did not become healthy in time"
    ui::hint "Logs: ${RUN_STATE}/relay.log"
    RELAY_EXIT=1
  fi
else
  ui::skip "relay (not selected)"
fi

# Daemon.
ui::step 3 4 "Daemon (Agent SDK supervisor)"
if [ "$WANT_DAEMON" = "1" ]; then
  if [ "$RELAY_EXIT" != "0" ]; then
    ui::skip "daemon (relay is not up)"
    DAEMON_EXIT=1
  else
    start_service "daemon" "exec env TELECODE_RELAY_URL=${RELAY_WS} node --import tsx packages/daemon/src/main.ts"
    if wait_log "${RUN_STATE}/daemon.log" "registered with relay" 20; then
      ui::ok "daemon registered (pid $(cat ${RUN_STATE}/daemon.pid))"
    else
      ui::warn "daemon did not confirm registration in time (it may still be connecting)"
      ui::hint "Logs: ${RUN_STATE}/daemon.log"
    fi
  fi
else
  ui::skip "daemon (not selected)"
fi

# Web.
ui::step 4 4 "Web (http://127.0.0.1:${WEB_PORT})"
if [ "$WANT_WEB" = "1" ]; then
  free_port "$WEB_PORT"
  start_service "web" "cd apps/web && exec ./node_modules/.bin/vite dev --port ${WEB_PORT} --strictPort --host 127.0.0.1"
  if wait_http "http://127.0.0.1:${WEB_PORT}" 60; then
    ui::ok "web up (pid $(cat ${RUN_STATE}/web.pid))"
  else
    ui::fail "web dev server did not come up in time"
    ui::hint "Logs: ${RUN_STATE}/web.log"
    WEB_EXIT=1
  fi
else
  ui::skip "web (not selected)"
fi

# --- Summary ----------------------------------------------------------------
ui::summary_begin "Stack Summary"
[ "$WANT_RELAY" = "1" ]  && ui::summary_row "relay"  "http://127.0.0.1:${RELAY_PORT}/healthz" "$([ "$RELAY_EXIT" = 0 ] && echo ok || echo fail)"
[ "$WANT_DAEMON" = "1" ] && ui::summary_row "daemon" "-> ${RELAY_WS}" "$([ "$DAEMON_EXIT" = 0 ] && echo ok || echo warn)"
[ "$WANT_WEB" = "1" ]    && ui::summary_row "web"    "http://127.0.0.1:${WEB_PORT}" "$([ "$WEB_EXIT" = 0 ] && echo ok || echo fail)"
ui::summary_end

TOTAL_EXIT=$((RELAY_EXIT | WEB_EXIT))
if [ "$TOTAL_EXIT" -eq 0 ]; then
  ui::ok "Stack is up. Stop it with 'make stop'."
else
  ui::fail "One or more services failed to start (see logs in ${RUN_STATE}/)"
fi
exit "$TOTAL_EXIT"
