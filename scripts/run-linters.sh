#!/usr/bin/env bash
# scripts/run-linters.sh — run telecode's code-quality gates; aggregate exit codes.
#
# Run via: make lint | make lint-fix
#
# Critical rule: never exit on first failure. Run every selected check, aggregate
# exit codes (bitwise OR), then exit with the aggregate — a lint GATE must surface
# ALL failures, not just the first.
#
# Fix mode (--fix) auto-fixes what it can (Prettier --write, ESLint --fix), then
# RE-RUNS the checks to verify (a failing check after --fix = something it cannot
# auto-fix).

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"
ui::init

FIX_MODE=0

print_help() {
  cat <<EOF
Usage: scripts/run-linters.sh [options]

Run telecode's code-quality gates (the same ones CI runs). Aggregates exit codes.

Options:
  --all          Run all checks (default)
  --fix          Auto-fix where supported (Prettier, ESLint), then re-check
  -h, --help     Show this help

Checks:
  - Types     pnpm typecheck   (tsc for relay/daemon/protocol; svelte-check for web)
  - ESLint    pnpm lint        (type-aware, --max-warnings 0)
  - Format    pnpm format:check (Prettier)
  - Supabase  supabase db lint  (skipped until supabase/migrations exists)

Examples:
  scripts/run-linters.sh
  scripts/run-linters.sh --fix
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) print_help; exit 0 ;;
    --all)     ;;  # explicit "all" is the default
    --fix)     FIX_MODE=1 ;;
    *)
      printf "ERROR: unknown argument: %s\n" "$1" >&2
      printf "Run with --help for usage.\n" >&2
      exit 2
      ;;
  esac
  shift
done

status_for_exit() { [ "$1" = "0" ] && echo "ok" || echo "fail"; }

if [ "$FIX_MODE" = "1" ]; then
  ui::banner "make lint-fix" "Auto-fixing telecode code-quality issues"
else
  ui::banner "make lint" "Running telecode code-quality checks"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  ui::die "pnpm not installed; run 'make setup' first" "https://pnpm.io/installation"
fi

# Is there a Supabase lint target yet? (No migrations in Phase 0.)
SUPABASE_STEP=0
if [ -d "supabase/migrations" ] && command -v supabase >/dev/null 2>&1; then
  SUPABASE_STEP=1
fi

TYPES_EXIT=0
ESLINT_EXIT=0
FORMAT_EXIT=0
SB_EXIT=0

# Total steps: optional fix step + types + eslint + format (+ supabase).
STEPS=$((3 + SUPABASE_STEP))
[ "$FIX_MODE" = "1" ] && STEPS=$((STEPS + 1))
CURRENT=0

# --- Fix pass (best-effort) -------------------------------------------------
if [ "$FIX_MODE" = "1" ]; then
  CURRENT=$((CURRENT + 1))
  ui::step "$CURRENT" "$STEPS" "Auto-fix (Prettier --write, ESLint --fix)"
  ui::run "prettier --write" "pnpm format" || true
  ui::run "eslint --fix" "pnpm exec eslint . --fix" || true
fi

# --- Types ------------------------------------------------------------------
CURRENT=$((CURRENT + 1))
ui::step "$CURRENT" "$STEPS" "Types (pnpm typecheck)"
ui::run "pnpm typecheck" "pnpm typecheck" || TYPES_EXIT=$?

# --- ESLint -----------------------------------------------------------------
CURRENT=$((CURRENT + 1))
ui::step "$CURRENT" "$STEPS" "ESLint (pnpm lint)"
if ui::run "pnpm lint" "pnpm lint"; then :; else
  ESLINT_EXIT=$?
  [ "$FIX_MODE" = "0" ] && ui::hint "Try 'make lint-fix' to auto-fix where possible"
fi

# --- Format -----------------------------------------------------------------
CURRENT=$((CURRENT + 1))
ui::step "$CURRENT" "$STEPS" "Format (pnpm format:check)"
if ui::run "pnpm format:check" "pnpm format:check"; then :; else
  FORMAT_EXIT=$?
  [ "$FIX_MODE" = "0" ] && ui::hint "Try 'make lint-fix' (runs Prettier --write)"
fi

# --- Supabase (optional) ----------------------------------------------------
if [ "$SUPABASE_STEP" = "1" ]; then
  CURRENT=$((CURRENT + 1))
  ui::step "$CURRENT" "$STEPS" "Supabase (supabase db lint)"
  if ui::run "supabase db lint" "supabase db lint"; then :; else
    SB_EXIT=$?
    ui::hint "Is the stack up? 'supabase db lint' needs a live database"
  fi
fi

# --- Summary + aggregate exit -----------------------------------------------
TOTAL_EXIT=$((TYPES_EXIT | ESLINT_EXIT | FORMAT_EXIT | SB_EXIT))

ui::summary_begin "Lint Summary"
ui::summary_row "Types"    "exit $TYPES_EXIT"  "$(status_for_exit "$TYPES_EXIT")"
ui::summary_row "ESLint"   "exit $ESLINT_EXIT" "$(status_for_exit "$ESLINT_EXIT")"
ui::summary_row "Format"   "exit $FORMAT_EXIT" "$(status_for_exit "$FORMAT_EXIT")"
[ "$SUPABASE_STEP" = "1" ] && ui::summary_row "Supabase" "exit $SB_EXIT" "$(status_for_exit "$SB_EXIT")"
ui::summary_end

if [ "$TOTAL_EXIT" -eq 0 ]; then
  ui::ok "All selected checks passed"
else
  ui::fail "One or more checks failed (aggregate exit $TOTAL_EXIT)"
fi

exit "$TOTAL_EXIT"
