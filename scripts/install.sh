#!/usr/bin/env bash
# scripts/install.sh — idempotent telecode developer environment setup.
#
# Run via: make setup
#
# Hard prerequisites (abort if missing): bash, git, curl, node
# Bootstraps:  pnpm (via npm) if missing
# Installs:    workspace deps (pnpm install); Playwright Chromium (apps/web)
# Configures:  .env from .env.example (if .env missing)
# Soft prereqs (warn but never fail): docker, supabase CLI
#
# Every step is idempotent — re-running is safe and skips what's already done.

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"
ui::init

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat <<EOF
Usage: scripts/install.sh [options]

Sets up the telecode developer environment. Idempotent — safe to re-run.

Options:
  -h, --help     Show this help

Hard prerequisites (aborts if missing): bash, git, curl, node (>=20)

What this installs:
  - pnpm (package manager) — via 'npm install -g pnpm' if missing
  - Workspace dependencies via 'pnpm install'
  - Playwright Chromium browser (for the web e2e)
  - .env from .env.example (if .env doesn't yet exist)

Soft prerequisites (warns but never fails): docker, supabase CLI
EOF
      exit 0
      ;;
    *)
      printf "ERROR: unknown argument: %s\n" "$arg" >&2
      exit 2
      ;;
  esac
done

INSTALLED=0
SKIPPED=0
WARNED=0

PNPM_VERSION="9.15.9" # keep in sync with package.json "packageManager"

check_hard_prereq() {
  local cmd="$1" hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ui::ok "$cmd"
    ui::detail "$("$cmd" --version 2>&1 | head -1)"
  else
    ui::die "$cmd is required but not installed." "$hint"
  fi
}

check_soft_prereq() {
  local cmd="$1" hint="$2"
  if command -v "$cmd" >/dev/null 2>&1; then
    ui::ok "$cmd found"
    ui::detail "$("$cmd" --version 2>&1 | head -1)"
  else
    ui::warn "$cmd not found"
    ui::hint "$hint"
    WARNED=$((WARNED + 1))
  fi
}

cmd_status() { command -v "$1" >/dev/null 2>&1 && echo "ok" || echo "warn"; }
cmd_value()  { command -v "$1" >/dev/null 2>&1 && command -v "$1" || echo "missing"; }

ui::banner "make setup" "Setting up the telecode developer environment"

# --- Step 1: Hard prerequisites ---------------------------------------------
ui::step 1 5 "Hard prerequisites"
check_hard_prereq git  "Install: https://git-scm.com/downloads"
check_hard_prereq curl "Install: https://curl.se/download.html"
check_hard_prereq bash "Bash 3.2+ required"
check_hard_prereq node "Install Node.js (>=20, see .nvmrc): https://nodejs.org"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
  ui::warn "Node $(node --version) is older than the supported >=20 (see .nvmrc)"
  WARNED=$((WARNED + 1))
fi

# --- Step 2: pnpm -----------------------------------------------------------
ui::step 2 5 "pnpm (package manager)"
if command -v pnpm >/dev/null 2>&1; then
  ui::skip "pnpm already installed ($(pnpm --version))"
  SKIPPED=$((SKIPPED + 1))
else
  if ! ui::run "npm install -g pnpm@${PNPM_VERSION}" "npm install -g pnpm@${PNPM_VERSION}"; then
    ui::die "pnpm installation failed" "Install manually: https://pnpm.io/installation"
  fi
  INSTALLED=$((INSTALLED + 1))
fi
command -v pnpm >/dev/null 2>&1 || ui::die "pnpm installed but not on PATH"

# --- Step 3: Workspace dependencies -----------------------------------------
ui::step 3 5 "Workspace dependencies (pnpm install)"
if ! ui::run "pnpm install" "pnpm install"; then
  ui::die "Dependency install failed" "Common cause: a package.json error in a workspace member"
fi
INSTALLED=$((INSTALLED + 1))

# --- Step 4: Playwright browser ---------------------------------------------
ui::step 4 5 "Playwright browser (Chromium)"
if [ ! -f "apps/web/package.json" ]; then
  ui::skip "apps/web not present — skipping browser install"
else
  # Idempotent: a no-op when the browser is already cached.
  if ! ui::run "playwright install chromium" "pnpm --filter @telecode/web exec playwright install chromium"; then
    ui::warn "Playwright browser install failed; 'make test-e2e' won't run until resolved"
    WARNED=$((WARNED + 1))
  else
    INSTALLED=$((INSTALLED + 1))
  fi
fi

# --- Step 5: .env + soft prerequisites --------------------------------------
ui::step 5 5 "Environment + soft prerequisites"
if [ -f ".env" ]; then
  ui::skip ".env already exists"
elif [ -f ".env.example" ]; then
  cp .env.example .env
  ui::ok ".env created from .env.example"
  ui::hint "Edit .env to set ANTHROPIC_API_KEY (for the daemon's Agent SDK)"
else
  ui::warn ".env.example not found; skipping .env generation"
  WARNED=$((WARNED + 1))
fi

check_soft_prereq docker   "Needed for the self-hosted relay + Supabase stack later. https://www.docker.com/products/docker-desktop"
check_soft_prereq supabase "The Postgres data layer CLI (Phase 1+). https://supabase.com/docs/guides/cli"

# --- Summary dashboard ------------------------------------------------------
ui::summary_begin "Installation Summary"
ui::summary_row "pnpm"          "$(pnpm --version 2>/dev/null)"   "ok"
ui::summary_row "node"          "$(node --version 2>/dev/null)"   "$([ "$NODE_MAJOR" -ge 20 ] && echo ok || echo warn)"
ui::summary_row "docker"        "$(cmd_value docker)"             "$(cmd_status docker)"
ui::summary_row "supabase CLI"  "$(cmd_value supabase)"           "$(cmd_status supabase)"
ui::summary_row ".env"          "$([ -f .env ] && echo present || echo missing)" "$([ -f .env ] && echo ok || echo warn)"
ui::summary_end

printf "  %s%s installed · %s skipped · %s warnings%s\n" \
  "${UI_DIM}" "$INSTALLED" "$SKIPPED" "$WARNED" "${UI_RESET}"
printf "  %sNext: '%smake start%s' (backend) or '%smake run%s' (everything).%s\n\n" \
  "${UI_DIM}" "${UI_PRIMARY}" "${UI_DIM}" "${UI_PRIMARY}" "${UI_DIM}" "${UI_RESET}"
