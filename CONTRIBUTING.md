# Contributing to telecode

Thanks for your interest in telecode — an open-source, self-hostable, end-to-end-encrypted command
center for Claude Code agents. Contributions of all kinds are welcome: bug reports, fixes, docs, and
features. This guide gets you productive fast and explains the bar a change has to clear.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug** — open a [bug report](https://github.com/PouyanJay/telecode/issues/new/choose).
- **Request a feature** — open a feature request and describe the problem, not just the solution.
- **Fix or build something** — comment on an issue first (or open one) so we can agree on the approach
  before you invest time.
- **Improve the docs** — corrections and clarifications to `docs/` and the READMEs are always valued.

> Found a **security vulnerability**? Do **not** open a public issue — follow the
> [Security Policy](./SECURITY.md) for private disclosure.

## Project layout

telecode is a TypeScript monorepo (pnpm workspaces + Turborepo):

| Path                | What it is                                                                 |
| ------------------- | -------------------------------------------------------------------------- |
| `apps/web`          | The SvelteKit PWA — the product UI (the mobile story; no native app)       |
| `apps/relay`        | The Node + Fastify + `ws` relay — the outbound-only control plane / broker |
| `packages/daemon`   | The Node + Claude Agent SDK daemon that runs on your machine               |
| `packages/protocol` | Shared zod schemas + crypto helpers — the wire contract                    |
| `packages/ui`       | The shared design system (tokens + primitives)                             |
| `docs/`             | User-facing docs + the threat model                                        |

## Development setup

**Prerequisites:** Node **22+** (the E2E crypto uses WebCrypto X25519), pnpm, and Docker (for the local
Supabase Postgres).

```sh
pnpm install          # install the workspace
make run              # start the relay + daemon + web together (reads .env)
```

`make run` writes logs to `.run-state/`; the daemon's pairing code is in `.run-state/daemon.log`. Open the
web app, sign in, and enter the code to pair. `make stop` stops everything. See `docs/getting-started.md`
for the full flow.

## The bar for a change

Every change is test-first and must pass the same gates CI runs. Run them locally before opening a PR:

```sh
pnpm typecheck        # tsc --noEmit across the workspace
pnpm lint             # ESLint (zero warnings)
pnpm format:check     # Prettier
pnpm --filter web check   # svelte-check (for UI changes)
pnpm test             # Vitest (the relay suite needs the local Postgres up)
```

- **Test-first.** Add or extend a test that fails for the right reason, then make it pass. Integration
  tests that traverse real layers are preferred over mock-heavy unit tests.
- **Keep the gates green.** Don't merge with failing types, lint, format, or tests.
- **Match the surrounding code.** Strict TypeScript (no `any` — use `unknown` + narrowing), discriminated
  unions with exhaustiveness checks, validation at trust boundaries with zod, structured logging via pino.
- **UI work** follows the design system in `packages/ui` — consume tokens, reuse primitives, cover all
  interaction/data states, and meet WCAG 2.2 AA. No one-off inline styles.

## Architecture invariants (please don't break these)

These keep telecode trust-minimized; a PR that violates one won't be merged without a very good reason:

1. **Outbound-only relay.** Both the browser and the daemon dial _out_ to the relay; nothing reaches into
   your machine. The relay is a multiplexer keyed by `(user_id, device_id)`.
2. **Execution stays on your machine.** The relay never runs agent work.
3. **Agent SDK, never CLI scraping.** The daemon uses the Claude Agent SDK behind a thin `AgentAdapter`
   seam — it does not parse terminal output.
4. **The approval gate is the safety boundary.** Every consequential tool call passes through the
   human-in-the-loop permission hook before it runs.
5. **End-to-end encrypted.** The relay only ever forwards ciphertext plus routing metadata; crypto lives
   in `packages/protocol`. See [`docs/threat-model.md`](./docs/threat-model.md).

## Opening a pull request

1. Fork and branch from `main` (`fix/...`, `feat/...`).
2. Make focused commits with clear, descriptive messages about the change.
3. Ensure all gates pass and tests cover the change.
4. Open the PR using the template; link the issue it addresses and describe what you changed and how you
   verified it.
5. A maintainer will review. Address review feedback by pushing follow-up commits.

## License

By contributing, you agree that your contributions are licensed under the project's
[AGPL-3.0](./LICENSE) license.
