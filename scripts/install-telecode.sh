#!/usr/bin/env bash
#
# install-telecode.sh — one-line installer for the telecode daemon.
#
#   curl -fsSL https://telecode.pouyan.ai/install.sh | bash
#
# Installs the `telecode` command globally via npm, then tells you how to pair this machine. The daemon
# runs Claude Code agents locally and dials OUT to the relay — nothing ever reaches into your machine.
# Self-contained on purpose (no repo checkout needed): safe to pipe straight from curl.
#
# NOTE: telecode is not yet published to npm — see docs/publishing.md for the maintainer publish runbook.
# Once published, this script works as-is.

set -euo pipefail

MIN_NODE_MAJOR=22
PACKAGE="telecode"

# Colors only when stdout is a TTY (a piped install stays plain).
if [ -t 1 ]; then
  bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; amber=$'\033[33m'; reset=$'\033[0m'
else
  bold=''; dim=''; red=''; green=''; amber=''; reset=''
fi

info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$green" "$reset" "$*"; }
warn()  { printf '%s!%s %s\n' "$amber" "$reset" "$*"; }
fail()  { printf '%s✗ %s%s\n' "$red" "$*" "$reset" >&2; exit 1; }

info "${bold}telecode${reset} — install the local agent daemon"
info ""

# 1. Node.js present and new enough (WebCrypto X25519 needs Node 22+).
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed. Install Node ${MIN_NODE_MAJOR}+ from https://nodejs.org and re-run this."
fi
node_version="$(node -v 2>/dev/null | sed 's/^v//')"
node_major="${node_version%%.*}"
if [ -z "$node_major" ] || [ "$node_major" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node ${node_version:-unknown} is too old — telecode needs Node ${MIN_NODE_MAJOR}+ (WebCrypto). Upgrade and re-run."
fi
ok "Node v${node_version}"

# 2. An installer (npm) to pull the package.
if ! command -v npm >/dev/null 2>&1; then
  fail "npm is not installed. It ships with Node.js — reinstall Node from https://nodejs.org."
fi

# 3. Install the CLI globally.
info "${dim}Installing ${PACKAGE} globally via npm…${reset}"
if ! npm install -g "$PACKAGE"; then
  fail "npm could not install ${PACKAGE}. If this is a permissions error, see https://docs.npmjs.com/resolving-eacces-permissions-errors."
fi
ok "Installed the ${bold}telecode${reset} command"

info ""
info "${bold}Next steps${reset}"
info "  1. Run ${bold}telecode${reset} on this machine — it prints a pairing code."
info "  2. Open the telecode web app and enter the code to pair this device."
info "  3. Launch a session from any browser; approve tool calls as they come."
info ""
info "  Check your setup any time with ${bold}telecode doctor${reset}."
