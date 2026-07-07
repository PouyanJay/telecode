# telecode documentation

Telecode is an open-source, self-hostable command center for Claude Code agents: the agents run on **your**
machine, and you launch, watch, and steer them from any browser — with session content **end-to-end
encrypted**, so the relay in the middle only ever forwards ciphertext.

Start with the [project README](../README.md) for the one-paragraph overview and install steps. These
pages go deeper. Each is self-contained and cross-links the others where concepts meet; the diagrams are
authored in **Mermaid** and render on GitHub.

## Use it

- **[Getting started](getting-started.md)** — install the daemon, pair a machine, keep it running in the
  background, and launch your first session, with `telecode doctor` for preflight.
- **[Branches, changes & PRs](branches-and-changes.md)** — every launched session works on its own
  branch: review the real diff, switch or fork branches, push, and open a PR from the browser.
- **[Adopted sessions](adopted-sessions.md)** — Claude Code sessions you start in a terminal appear in
  telecode automatically: watch them, answer their questions, and approve their tool calls remotely.
- **[Reconnecting & offline behavior](reconnect-and-offline.md)** — why reopening is a _reconnect_ (never
  a restart), how network drops, laptop sleep/wake, and daemon restarts are handled, and what a
  powered-off machine can't do.

## Understand it

- **[Connecting your machine](connecting-your-machine.md)** — how your browser reaches a laptop behind a
  router with no open ports, and how telecode knows a paired machine belongs to _exactly_ you (sign-in
  identity + the device-pairing flow). Plain language, with diagrams.
- **[End-to-end encryption](end-to-end-encryption.md)** — how the relay only ever sees ciphertext: the
  keys, the handshake, and a message's round trip — built on X25519 · ECDH · HKDF · AES-256-GCM. Plain
  language, with diagrams.
- **[Threat model](threat-model.md)** — the adversary's-eye view: what each part _can_ and _cannot_ see,
  the approval gate, and how to verify the relay only ever holds ciphertext.

## Operate it

- **[Self-hosting the relay](self-hosting.md)** — run your own relay with Docker, so even the routing
  metadata stays with you.
- **[Deploying to Azure](deploy-azure.md)** — the production runbook: web app + relay on Azure Container
  Apps (Bicep IaC + CI/CD), Postgres on managed Supabase.
- **[Telemetry & privacy](telemetry.md)** — telecode collects nothing by default; what the self-host-only
  opt-in operational metrics do and don't include.
- **[Publishing the CLI](publishing.md)** — maintainer runbook for shipping the `telecode` command to npm.

---

New to the project? Read **[Connecting your machine](connecting-your-machine.md)** and
**[End-to-end encryption](end-to-end-encryption.md)** together — between them they explain the whole trust
model in plain language.
