# Changelog

All notable changes to telecode are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor bumps may contain breaking
changes).

Versions below are releases of the **`@telecode/cli`** npm package (the daemon — the thing you install).
The web app and relay deploy continuously from `main`; changes that live purely in the web app or relay
are listed under the CLI release they accompanied.

## Unreleased — web app (deploys continuously from `main`)

### Added

- **Delete from the board card.** Ended sessions get a trash button on their dashboard row — one
  confirm dialog, then the session and its encrypted history are gone. Files and branches on your
  machine are never touched (the fuller options, including worktree cleanup, stay in the session
  view).
- **Dismissible needs-you cards.** Approval, question, and takeover cards can be closed without
  answering: the ask stays pending, the session's row carries an amber "N waiting" chip until it's
  resolved, the section header counts hidden cards honestly, and dismissals survive reloads. A new
  ask from the same session always shows a fresh card.

## [0.7.3] — 2026-07-08

### Fixed

- **Continuations now respect your default permission mode.** "Resume as new" and the one-step
  takeover start a NEW session — but it silently inherited the old chain's permission mode, so a
  user who switched their default to Bypass kept getting approval prompts on every continuation.
  A new linked session now starts in your saved default mode, exactly like a fresh launch.
- **Handover continuations keep the terminal's mode.** Taking over a local session that ran with
  permissions bypassed no longer produces a suddenly-gated continuation — the child keeps the mode
  the local session actually ran in.

## [0.7.2] — 2026-07-08

### Added

- **Bypass permissions as a launch mode.** The launch drawer and Settings now offer a fourth
  permission mode: everything runs without asking — full access to your machine — while **questions
  still stop for you**. The shipped default remains "Approve edits"; bypass is an explicit choice.
- **Real question cards for launched sessions.** An `AskUserQuestion` from a telecode-launched
  session now arrives as the structured multiple-choice picker (like adopted sessions), in every
  permission mode, instead of a raw approve/reject gate that couldn't actually answer it.

## [0.7.1] — 2026-07-08

### Fixed

- **Runs no longer die at 4 turns.** Every daemon-launched run was silently capped at 4 agent turns —
  far too small for real work. The cap is now a runaway safety net (100), and hitting it settles as
  the followable "Ended — turn limit" (a follow-up message continues the same conversation) instead
  of "Failed".
- **A taken-over conversation can't lose its context mid-flight.** A failure during a fork-resume was
  misread as "the conversation can't be resumed" and silently restarted fresh; now the fallback only
  fires when the conversation truly never started.
- **A failed run stays resumable.** A turn that failed mid-run kept no conversation id, so the next
  follow-up dead-ended in "Needs restart"; the id is now kept and follow-ups resume.

## [0.7.0] — 2026-07-08

The adopted-session steering release: sessions you started in your own terminal are now honest about
their state and can be taken over remotely in one step. See
[docs/adopted-sessions.md](docs/adopted-sessions.md).

### Added

- **"At your terminal".** An adopted session between turns now shows a calm AT YOUR TERMINAL state
  instead of reading RUNNING forever, and flips back to RUNNING the moment a new local turn starts
  (including chat-only turns).
- **One-step takeover.** Between turns, the composer is live: sending your next task continues the
  conversation in a new linked telecode-owned session — with a guard that never severs a session you
  resumed typing into locally (it becomes an honest linked fork instead).
- **Honest composer & controls.** Mid-turn adopted sessions say why sending is unavailable instead of
  spinning; Interrupt (which could do nothing) is gone for adopted sessions and End reads
  **Stop following** — mirroring stops, your local process is untouched.
- **Session controls on phones.** Interrupt / End / Stop following are now visible and usable on
  small screens.
- **Readable takeover cards.** Handover questions render as real markdown — on the dashboard card
  (clamped preview with an honest fade) and in the session view.

## [0.6.0] — 2026-07-07

The branch workflow release: every launched session works on its own branch, and you can review, switch,
fork, and ship that work from the browser. See [docs/branches-and-changes.md](docs/branches-and-changes.md).

### Added

- **A branch per session.** Launching a session in a repository cuts a dedicated git worktree and branch,
  so parallel sessions never trample each other. Branch names are readable auto-slugs derived from the
  task, or set your own; pick any base branch to start from (fetched live, end-to-end encrypted in
  transit).
- **Session branch visibility.** The session header and the session rail show which branch (and repo)
  each session is on.
- **Real Changes panel.** The Changes tab shows the session branch's actual diff against its base —
  reviewable from your phone, not just a transcript of edits.
- **Between-turns branch switch** for launched sessions, while the agent is idle.
- **Fork onto a branch.** Resume-as-new can fork a past session's conversation onto a fresh branch of
  your choosing.
- **Push & open a PR.** Push the session branch to the origin and jump straight to the pull-request page.
- **Reap on delete.** Deleting a session can also remove its worktree and branch (with safety checks).

Adopted (locally started) sessions are observers of your own checkout, so branch switch and push are
deliberately refused for them.

## [0.5.0] – [0.5.6] — 2026-07-06 / 2026-07-07

The session-identity and multi-device era: sessions got real names, history that survives restarts, and
honest per-device presence.

### Added

- **Session titles, end-to-end sealed.** Sessions get quality titles (with the repo tagged), backfilled
  for restored sessions — and titles are encrypted like content, so the relay can't read them.
- **Rename, resume-as-new, and housekeeping.** Rename sessions, resume a finished one as a new session
  that keeps the conversation, and clean up old sessions in bulk.
- **Restart persistence.** A daemon restart no longer strands its sessions: transcripts are restored and
  the registry self-reconciles instead of accumulating phantom rows.
- **Multi-device, for real** (web + relay). Per-device live presence, a device picker at launch, device
  chips and deep links on the board, per-device adoption settings, and honest `DEVICE OFFLINE` /
  `REVOKED` placeholders instead of an infinite "reconnecting" state. Approvals work across devices.
- **Clearer statuses.** The lifecycle status a session shows now distinguishes what the agent is doing
  rather than collapsing everything into "running".

### Fixed

- Mobile polish across the board views.
- A latent transport wedge where frames sent before the hello handshake completed could freeze a
  connection's send chain.

## [0.4.0] – [0.4.7] — 2026-07-04 / 2026-07-06

Hardening of adoption, approvals, and the device lifecycle.

### Added

- **Threads & lineage** (0.4.6). Chained sessions display their lineage, with a "continuation" pill
  linking a resumed session back to its ancestor.
- **Revoke → re-authorize lifecycle** (0.4.7). Revoking a device now cleanly ends its sessions; a revoked
  daemon auto-re-pairs **preserving its identity**, so history survives re-authorization. Revoked devices
  are listed with a re-authorize flow.
- **Auto re-pair on a revoked token** (0.4.0). A daemon whose device token was revoked stops looping on
  auth errors and prints a fresh pairing code instead (one human approval re-grants it).

### Fixed

- **Adoption safety** (0.4.1–0.4.4): adopted sessions honor their own permission mode (bypass/auto modes
  are never gated) and only gate when a browser is actually watching; the transcript mirrors on every
  agent stop, not just handovers; daemon restarts reconcile the session registry so phantom sessions
  can't accumulate.
- **Approval reliability** (0.4.5): fixed a key-delivery race where a browser that subscribed at the
  wrong moment couldn't decrypt — and its approval decisions were silently dropped, leaving the gate
  stuck. The session key is now (re)delivered on subscribe.
- Concurrent approvals resolve the request you actually clicked, not the first pending one.

## [0.3.0] — 2026-07-04

### Added

- **Background service.** `telecode service install|uninstall|start|stop|status|logs` — an install-once
  login service (launchd on macOS, systemd user unit on Linux) that keeps the daemon running in the
  background and restarts it on crash. First run offers to set it up. Windows is a documented
  fast-follow.

## [0.2.0] — 2026-07-03

### Added

- **Adopted sessions.** Claude Code sessions you start locally in a terminal appear in telecode
  automatically: watch the mirrored transcript live, answer the agent's questions, and approve or deny
  tool calls from the browser — including structured deny feedback and a free-form handover that resumes
  the conversation as a telecode session. Hooks install automatically; a web toggle (and
  `TELECODE_ADOPT=0`) turns adoption off.

## [0.1.0] — 2026-06-28

First published release (`@telecode/cli` / `@telecode/protocol`).

### Added

- **Launch & steer agents from the browser.** Start Claude Code agent sessions on a paired machine, watch
  output stream live, approve or reject each consequential tool call, and steer with follow-up messages —
  from a phone or another laptop.
- **Mobile-first web app.** The web app is the mobile experience (no native app): responsive on a phone,
  with web push for awaiting-input alerts.
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

[0.6.0]: https://www.npmjs.com/package/@telecode/cli/v/0.6.0
[0.5.0]: https://www.npmjs.com/package/@telecode/cli/v/0.5.0
[0.5.6]: https://www.npmjs.com/package/@telecode/cli/v/0.5.6
[0.4.0]: https://www.npmjs.com/package/@telecode/cli/v/0.4.0
[0.4.7]: https://www.npmjs.com/package/@telecode/cli/v/0.4.7
[0.3.0]: https://www.npmjs.com/package/@telecode/cli/v/0.3.0
[0.2.0]: https://www.npmjs.com/package/@telecode/cli/v/0.2.0
[0.1.0]: https://www.npmjs.com/package/@telecode/cli/v/0.1.0
