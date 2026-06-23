#!/usr/bin/env bash
# scripts/help.sh — render the formatted `make help` reference.
#
# Wired by the Makefile's default `help` target. Lists every target the Makefile
# defines; keep it in sync whenever a target is added or removed.

set -euo pipefail

source "$(dirname "$0")/lib/ui.sh"

ui::_logo

ui::section "Help"
ui::cmd "make help"        "Print this command reference (default)"

ui::section "Setup & Run"
ui::cmd "make setup"       "Install dev dependencies (pnpm, browsers, .env) — idempotent"
ui::cmd "make run"         "One command from a fresh clone: setup + start the full stack"
ui::cmd "make start"       "Start the backend (relay + daemon) — reuses if healthy"
ui::cmd "make start-all"   "Start the full stack (relay + daemon + web)"
ui::cmd "make stop"        "Stop all services started by 'make start'"

printf "    %sHealthy services are reused; a taken port auto-relocates to a free one.%s\n" "${UI_DIM}" "${UI_RESET}"

ui::section "Testing"
ui::cmd "make test"        "Run all suites: Vitest + Playwright e2e"
ui::cmd "make test-unit"   "Vitest only (unit + integration)"
ui::cmd "make test-e2e"    "Playwright e2e only (real browser)"

ui::section "Linting"
ui::cmd "make lint"        "Run all checks: typecheck + ESLint + Prettier (+ supabase)"
ui::cmd "make lint-fix"    "Auto-fix where supported, then re-check"

printf "\n  %sStack: pnpm + Turborepo monorepo — SvelteKit web · Fastify+ws relay ·%s\n" "${UI_DIM}" "${UI_RESET}"
printf "  %sClaude Agent SDK daemon · shared protocol. See CLAUDE.md for the contract.%s\n\n" "${UI_DIM}" "${UI_RESET}"
