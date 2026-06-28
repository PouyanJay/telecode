# Changelog

All notable changes to telecode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches its first published release.

telecode is pre-1.0 and ships from `main`. Until the first tagged/published release, everything below sits
under **Unreleased**; versioned sections will be added as releases are cut.

## [Unreleased]

### Added

- **Launch & steer agents from the browser.** Start Claude Code agent sessions on a paired machine, watch
  output stream live, approve or reject each consequential tool call, and steer with follow-up messages —
  from a phone or another laptop.
- **Installable PWA.** The web app installs to a phone home screen and supports web push for
  awaiting-input alerts; this is the mobile experience (no native app).
- **Multiple parallel sessions** with a dashboard that sorts blocked ("awaiting input") sessions to the
  top, plus reconnect that restores the session list and backfills transcripts.
- **End-to-end encryption.** Prompts, output, and diffs are encrypted in the browser and the daemon
  (X25519 ECDH → HKDF → AES-256-GCM); the relay only ever forwards ciphertext plus routing metadata. The
  browser identity key is non-extractable and persisted in IndexedDB.
- **Self-hosting.** One-command Docker bundle (relay + Postgres + Redis + migrations) so you can run the
  only network component yourself. See [`docs/self-hosting.md`](docs/self-hosting.md).
- **Resilience.** Browser and daemon auto-reconnect across network drops and laptop sleep/wake; sessions
  go offline-paused and resume on reconnect (reopen is a reconnect, never a restart).
- **Rich transcript rendering** — a git diff viewer, offline syntax highlighting, and collapsible tool
  logs.
- **`telecode doctor`** diagnostics and a one-line installer for the daemon.
- **Marketing site** — a prerendered landing page describing telecode (`telecode.io`), maintained in a
  separate repository.
- **Hosted-relay hardening** — per-IP HTTP rate limiting (Redis-backed, in-memory fallback), tighter
  limits on the public pairing endpoints, a request body-size cap, a per-IP WebSocket connection cap, and
  device-pairing brute-force lockout. Safe to leave a relay running publicly.
- **Opt-in, identifier-free telemetry** that is off by default — telecode collects nothing unless an
  operator explicitly opts in, and even then only to their own logs. See [`docs/telemetry.md`](docs/telemetry.md).
- **Community files** — contributing guide, security policy, code of conduct, and issue/PR templates.

### Security

- The relay never sees plaintext session content — verified by integration tests that assert only
  ciphertext crosses it. The human-in-the-loop approval gate is the execution safety boundary. See the
  [threat model](docs/threat-model.md).

### Licensing

- Licensed under **AGPL-3.0**.

[unreleased]: https://github.com/PouyanJay/telecode/commits/main
