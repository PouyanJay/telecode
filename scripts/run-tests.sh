#!/usr/bin/env bash
# scripts/run-tests.sh — run telecode's test suites; aggregate exit codes.
#
# Run via: make test | make test-unit | make test-e2e
#
# Critical rule: never exit on first failure. Run every selected suite, aggregate
# exit codes, then exit with the aggregate — developers need to see ALL failures.

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"
ui::init

WANT_UNIT=1
WANT_E2E=1

print_help() {
  cat <<EOF
Usage: scripts/run-tests.sh [options]

Run telecode's test suites. Aggregates exit codes across all selected suites.

Options:
  --all          Run all suites (default): Vitest + Playwright
  --unit         Vitest only (unit + integration across all packages)
  --e2e          Playwright only (real-browser walking-skeleton e2e)
  -h, --help     Show this help

Notes:
  - "Unit" runs 'pnpm test' (Vitest), which covers both unit and the
    integration tests (real relay/daemon/protocol over loopback).
  - "--e2e" installs the Playwright Chromium browser first if missing.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) print_help; exit 0 ;;
    --all)     ;;  # default
    --unit)    WANT_UNIT=1; WANT_E2E=0 ;;
    --e2e)     WANT_UNIT=0; WANT_E2E=1 ;;
    *)
      printf "ERROR: unknown argument: %s\n" "$1" >&2
      printf "Run with --help for usage.\n" >&2
      exit 2
      ;;
  esac
  shift
done

status_for_exit() { [ "$1" = "0" ] && echo "ok" || echo "fail"; }

ui::banner "make test" "Running telecode test suites"

if ! command -v pnpm >/dev/null 2>&1; then
  ui::die "pnpm not installed; run 'make setup' first" "https://pnpm.io/installation"
fi

STEPS=$((WANT_UNIT + WANT_E2E))
[ "$STEPS" -eq 0 ] && ui::die "No test suites selected"
CURRENT=0

UNIT_EXIT=0
E2E_EXIT=0

# --- Vitest (unit + integration) --------------------------------------------
if [ "$WANT_UNIT" = "1" ]; then
  CURRENT=$((CURRENT + 1))
  ui::step "$CURRENT" "$STEPS" "Vitest (unit + integration)"
  ui::run "pnpm test" "pnpm test" || UNIT_EXIT=$?
fi

# --- Playwright (e2e) -------------------------------------------------------
if [ "$WANT_E2E" = "1" ]; then
  CURRENT=$((CURRENT + 1))
  ui::step "$CURRENT" "$STEPS" "Playwright (e2e)"
  # Idempotent: a no-op if the browser is already installed.
  ui::run "playwright install chromium" \
    "pnpm --filter @telecode/web exec playwright install chromium" || true
  ui::run "pnpm --filter @telecode/web test:e2e" \
    "pnpm --filter @telecode/web test:e2e" || E2E_EXIT=$?
fi

# --- Summary + aggregate exit -----------------------------------------------
TOTAL_EXIT=$((UNIT_EXIT | E2E_EXIT))

ui::summary_begin "Test Summary"
[ "$WANT_UNIT" = "1" ] && ui::summary_row "Vitest"     "exit $UNIT_EXIT" "$(status_for_exit "$UNIT_EXIT")"
[ "$WANT_E2E" = "1" ]  && ui::summary_row "Playwright" "exit $E2E_EXIT"  "$(status_for_exit "$E2E_EXIT")"
ui::summary_end

if [ "$TOTAL_EXIT" -eq 0 ]; then
  ui::ok "All selected suites passed"
else
  ui::fail "One or more suites failed (aggregate exit $TOTAL_EXIT)"
fi

exit "$TOTAL_EXIT"
