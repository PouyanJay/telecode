#!/usr/bin/env bash
# scripts/run.sh — boot (or tear down) the telecode dev stack.
#
# Run via: make start (backend) | make start-all (everything) | make stop
#          make run = make setup + make start-all (one command from a fresh clone)
#
# Services (Phase 0):
#   relay   Fastify + ws control plane   http://127.0.0.1:8080  (/healthz)
#   daemon  Claude Agent SDK supervisor  (dials out to the relay)
#   web     SvelteKit dev server         http://127.0.0.1:5173
#
# Optimised for fast, safe re-runs:
#   - Restart, don't recreate: a service that is already up AND healthy is
#     REUSED untouched (no kill/relaunch).
#   - Auto port: if a default port is held by a FOREIGN process, the service
#     relocates to the next free port instead of killing it or failing. The web
#     is told the relay's actual URL — both the browser's WS endpoint
#     (PUBLIC_TELECODE_RELAY_URL) and the web server's HTTP endpoint
#     (RELAY_HTTP_URL) — so all three always agree on a relocated relay.
#   - Only our own processes are ever stopped (tracked via .run-state/).

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"
ui::init

RELAY_PORT_DEFAULT=8080
WEB_PORT_DEFAULT=5173
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

Already-healthy services are reused; if a default port is taken by another
process the service relocates to the next free port automatically.
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

# --- Port helpers -----------------------------------------------------------

# port_listener_pid PORT — PID listening on PORT (listeners only), or empty.
port_listener_pid() { lsof -ti ":$1" -sTCP:LISTEN 2>/dev/null | head -n 1; }

# pick_free_port START — first free TCP port at or above START (scans up to +50).
pick_free_port() {
  local p="$1"
  local max=$(($1 + 50))
  while [ "$p" -lt "$max" ]; do
    [ -z "$(port_listener_pid "$p")" ] && { printf "%s" "$p"; return 0; }
    p=$((p + 1))
  done
  printf "%s" "$1"; return 1
}

# resolve_port DESIRED LABEL — choose a port to bind. Our own stale instance is
# reaped before this is called, so any holder here is foreign: relocate rather
# than kill it. Echoes the chosen port on STDOUT; status goes to STDERR.
resolve_port() {
  local desired="$1" label="$2" pid
  pid="$(port_listener_pid "$desired")"
  if [ -z "$pid" ]; then
    printf "%s" "$desired"; return 0
  fi
  local holder
  holder="$(ps -o comm= -p "$pid" 2>/dev/null | head -n 1)"
  ui::warn "${label}: port ${desired} is in use by ${holder:-pid $pid}" >&2
  local alt
  alt="$(pick_free_port $((desired + 1)))"
  ui::info "${label}: relocating to free port ${alt}" >&2
  printf "%s" "$alt"
}

# --- Process helpers --------------------------------------------------------

service_alive() {
  local pidfile="${RUN_STATE}/$1.pid" pid
  [ -f "$pidfile" ] || return 1
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

http_ok() { curl -fsS --max-time 2 "$1" >/dev/null 2>&1; }

recorded_port() { cat "${RUN_STATE}/$1.port" 2>/dev/null || true; }

stop_service() {
  local name="$1"
  local pidfile="${RUN_STATE}/${name}.pid"
  local pid
  if [ -f "$pidfile" ]; then
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      pkill -P "$pid" 2>/dev/null || true # sweep children first
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$pidfile"
  fi
  rm -f "${RUN_STATE}/${name}.port"
}

# start_service NAME "command" — nohup-start in the background. `exec` inside the
# subshell makes the recorded PID the real node/vite process (clean to signal).
start_service() {
  local name="$1"
  local cmd="$2"
  local logfile="${RUN_STATE}/${name}.log"
  : >"$logfile"
  nohup bash -c "$cmd" >"$logfile" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" >"${RUN_STATE}/${name}.pid"
  disown 2>/dev/null || true
}

wait_http() {
  local url="$1" timeout="${2:-30}"
  curl -fsS --max-time "$timeout" \
    --retry "$timeout" --retry-delay 1 --retry-all-errors --retry-connrefused \
    "$url" >/dev/null 2>&1
}

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
    stop_service "$name" # kills only our tracked process — never foreign holders
    ui::ok "$name stopped"
  done
  ui::summary_begin "Stop Summary"
  ui::summary_row "relay" "stopped" "ok"
  ui::summary_row "daemon" "stopped" "ok"
  ui::summary_row "web" "stopped" "ok"
  ui::summary_end
  exit 0
fi

# --- Start mode -------------------------------------------------------------
ui::banner "make start" "Booting the telecode dev stack"

if [ -f ".env" ]; then
  set -a; . ./.env; set +a
fi
export LOG_LEVEL="${LOG_LEVEL:-info}"

ui::step 1 4 "Prerequisites"
command -v pnpm >/dev/null 2>&1 || ui::die "pnpm not installed" "Run 'make setup' first"
[ -d "node_modules" ] || ui::die "dependencies not installed" "Run 'make setup' first"
ui::ok "pnpm $(pnpm --version) · deps present"

RELAY_EXIT=0
DAEMON_EXIT=0
WEB_EXIT=0
relay_port="$RELAY_PORT_DEFAULT"
web_port="$WEB_PORT_DEFAULT"
relay_reused=0

# --- Relay ------------------------------------------------------------------
ui::step 2 4 "Relay"
if [ "$WANT_RELAY" = "1" ]; then
  existing_port="$(recorded_port relay)"
  if [ -n "$existing_port" ] && service_alive relay && http_ok "http://127.0.0.1:${existing_port}/healthz"; then
    relay_port="$existing_port"
    relay_reused=1
    ui::ok "relay already healthy on ${relay_port} — reused"
  else
    stop_service relay # reap our own stale instance, if any
    relay_port="$(resolve_port "$RELAY_PORT_DEFAULT" relay)"
    start_service "relay" "exec env RELAY_PORT=${relay_port} node --import tsx apps/relay/src/main.ts"
    echo "$relay_port" >"${RUN_STATE}/relay.port"
    if wait_http "http://127.0.0.1:${relay_port}/healthz" 30; then
      ui::ok "relay healthy on ${relay_port} (pid $(cat ${RUN_STATE}/relay.pid))"
    else
      ui::fail "relay did not become healthy in time"
      ui::hint "Logs: ${RUN_STATE}/relay.log"
      RELAY_EXIT=1
    fi
  fi
else
  ui::skip "relay (not selected)"
  relay_port="$(recorded_port relay)"; relay_port="${relay_port:-$RELAY_PORT_DEFAULT}"
fi
RELAY_WS="ws://127.0.0.1:${relay_port}/ws"
RELAY_HTTP="http://127.0.0.1:${relay_port}"

# --- Daemon -----------------------------------------------------------------
ui::step 3 4 "Daemon (Agent SDK supervisor)"
if [ "$WANT_DAEMON" = "1" ]; then
  if [ "$RELAY_EXIT" != "0" ]; then
    ui::skip "daemon (relay is not up)"
    DAEMON_EXIT=1
  elif [ "$relay_reused" = "1" ] && service_alive daemon; then
    ui::ok "daemon already running — reused"
  else
    stop_service daemon # relay (re)started ⇒ reconnect the daemon to it
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

# --- Web --------------------------------------------------------------------
ui::step 4 4 "Web"
if [ "$WANT_WEB" = "1" ]; then
  existing_web="$(recorded_port web)"
  # Reuse only if healthy AND the relay it was launched against is unchanged.
  if [ "$relay_reused" = "1" ] && [ -n "$existing_web" ] && service_alive web && http_ok "http://127.0.0.1:${existing_web}"; then
    web_port="$existing_web"
    ui::ok "web already up on ${web_port} — reused"
  else
    stop_service web
    web_port="$(resolve_port "$WEB_PORT_DEFAULT" web)"
    # PUBLIC_… is the browser's WS endpoint; RELAY_HTTP_URL is the web server's
    # endpoint for /device/approve + /channel-token. Both must point at the
    # actual relay port — pending pairing codes are in-memory per relay instance,
    # so a stale RELAY_HTTP_URL (from .env) would hit the wrong relay and break pairing.
    start_service "web" "cd apps/web && exec env PUBLIC_TELECODE_RELAY_URL=${RELAY_WS} RELAY_HTTP_URL=${RELAY_HTTP} ./node_modules/.bin/vite dev --port ${web_port} --strictPort --host 127.0.0.1"
    echo "$web_port" >"${RUN_STATE}/web.port"
    if wait_http "http://127.0.0.1:${web_port}" 60; then
      ui::ok "web up on ${web_port} (pid $(cat ${RUN_STATE}/web.pid))"
    else
      ui::fail "web dev server did not come up in time"
      ui::hint "Logs: ${RUN_STATE}/web.log"
      WEB_EXIT=1
    fi
  fi
else
  ui::skip "web (not selected)"
fi

# --- Summary ----------------------------------------------------------------
ui::summary_begin "Stack Summary"
[ "$WANT_RELAY" = "1" ]  && ui::summary_row "relay"  "http://127.0.0.1:${relay_port}/healthz" "$([ "$RELAY_EXIT" = 0 ] && echo ok || echo fail)"
[ "$WANT_DAEMON" = "1" ] && ui::summary_row "daemon" "-> ${RELAY_WS}" "$([ "$DAEMON_EXIT" = 0 ] && echo ok || echo warn)"
[ "$WANT_WEB" = "1" ]    && ui::summary_row "web"    "http://127.0.0.1:${web_port}" "$([ "$WEB_EXIT" = 0 ] && echo ok || echo fail)"
ui::summary_end

TOTAL_EXIT=$((RELAY_EXIT | WEB_EXIT))
if [ "$TOTAL_EXIT" -eq 0 ]; then
  [ "$WANT_WEB" = "1" ] && ui::info "Open http://127.0.0.1:${web_port}"
  ui::ok "Stack is up. Stop it with 'make stop'."
else
  ui::fail "One or more services failed to start (see logs in ${RUN_STATE}/)"
fi
exit "$TOTAL_EXIT"
