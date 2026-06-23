# telecode Makefile
#
# Thin dispatcher only — every target is a one-liner that invokes a script in
# scripts/. Logic lives there; see scripts/lib/ui.sh for the shared output
# library and .claude/plans/makefile-generation-generic-build-plan.md for the
# design. Run `make help` (or just `make`) for the command reference.

SHELL := /bin/bash
.DEFAULT_GOAL := help

# ── Help ─────────────────────────────────────────────────────────────────────
.PHONY: help

help:
	@./scripts/help.sh

# ── Setup & Run ──────────────────────────────────────────────────────────────
.PHONY: setup start start-all run stop

setup:
	@./scripts/install.sh

start:
	@./scripts/run.sh --backend-only

start-all:
	@./scripts/run.sh

# `make run` is the bulletproof end-to-end target: install everything from a
# fresh clone + start the full stack. The one command a contributor needs.
run: setup start-all

stop:
	@./scripts/run.sh --stop

# ── Testing ──────────────────────────────────────────────────────────────────
.PHONY: test test-unit test-e2e

test:
	@./scripts/run-tests.sh --all

test-unit:
	@./scripts/run-tests.sh --unit

test-e2e:
	@./scripts/run-tests.sh --e2e

# ── Linting ──────────────────────────────────────────────────────────────────
.PHONY: lint lint-fix

lint:
	@./scripts/run-linters.sh --all

lint-fix:
	@./scripts/run-linters.sh --all --fix
