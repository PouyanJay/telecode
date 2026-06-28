# telecode documentation

Start with the project [README](../README.md) for what telecode is and why. These guides go deeper:

- **[Getting started](./getting-started.md)** — install the daemon, pair a machine, and run your first
  session (with `telecode doctor` for preflight).
- **[Reconnecting & offline behavior](./reconnect-and-offline.md)** — why reopen is a reconnect, how
  reconnect and laptop sleep/wake are handled, and what doesn't survive a powered-off machine.
- **[Self-hosting the relay](./self-hosting.md)** — run your own relay with Docker so even routing metadata
  stays with you.
- **[Deploying to Azure](./deploy-azure.md)** — production runbook: the web app + relay on Azure Container
  Apps (Bicep IaC + CI/CD), with Postgres on managed Supabase.
- **[Threat model](./threat-model.md)** — exactly what each part can and cannot see, how the end-to-end
  encryption works, and how to verify the relay only sees ciphertext.
- **[Telemetry & privacy](./telemetry.md)** — telecode collects nothing by default; what the self-host-only
  opt-in operational metrics do and don't include.
- **[Publishing the CLI](./publishing.md)** — maintainer runbook for shipping the `telecode` command to
  npm.
