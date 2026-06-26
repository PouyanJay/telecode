# Publishing the `telecode` CLI

This is the maintainer runbook for shipping the daemon to npm so that `npx telecode` and the one-line
installer work on any machine. **telecode is not published yet** — the wiring is in place
(`packages/daemon` exposes a `telecode` bin, ships its TypeScript source, and carries `tsx` as a runtime
dependency), but the actual publish is deferred until the npm name and account are settled.

## What's already wired

- **`bin`** — `packages/daemon/package.json` maps the `telecode` command to `bin/telecode.mjs`, a tiny
  launcher that registers the `tsx` ESM loader and hands off to `src/main.ts`. The daemon ships as
  TypeScript and runs through `tsx` with no build step (the same way the relay image runs), so there is no
  compiled `dist/` to maintain.
- **`tsx` is a runtime dependency** — so the published bin can run on a user's machine without a build.
- **`files`** — only `bin/` and `src/` ship, with tests (`*.test.ts`) and the spike script excluded.
- **Publish metadata is complete** on both `packages/daemon` and `packages/protocol`: `license`
  (`AGPL-3.0-only`), `repository` (with `directory`), `homepage`, `bugs`, `author`, `keywords`, `engines`
  (`node >=22`), and `publishConfig.access: public`.
- **Dry-run verified.** With `private` temporarily disabled, `pnpm --filter @telecode/protocol publish
--dry-run` and `pnpm --filter @telecode/daemon publish --dry-run` both succeed and produce clean tarballs
  (pnpm rewrites the `workspace:*` protocol dependency to a real version range automatically). The packages
  keep `private: true` in the repo as the accidental-publish guard until release.
- **Installer** — `scripts/install-telecode.sh` is the `curl | sh` entry point (checks Node ≥ 22, then
  `npm install -g telecode`). It is self-contained so it can be piped straight from curl.

## The publish step (when ready)

1. **Pick the npm name + account.** The command is `telecode`, so the published package should be named
   `telecode` (not the internal `@telecode/daemon`). Reserve the name under the project's npm org.
2. **Resolve the workspace dependency.** The daemon imports `@telecode/protocol` (a `workspace:*`
   dependency). A standalone publish needs that resolved one of two ways:
   - **Publish `@telecode/protocol` publicly** (recommended): set it `private: false`, give it a real
     version, `npm publish --access public`, then have the daemon depend on the published version range.
   - **Bundle it** into the daemon publish (e.g. via `bundledDependencies` or a bundler) if keeping
     protocol unpublished is preferred.
3. **Flip the daemon package for publish:** set `"name": "telecode"`, `"private": false`, and a real
   `"version"`. (The rest of the manifest — `bin`, `files`, `tsx` runtime dep, and all the publish metadata
   above — is already in place.) Note the daemon is referenced internally as `@telecode/daemon` by the
   relay and web `devDependencies`; renaming it to `telecode` for publish means doing so as a release-time
   step (or updating those references), so this flip is deliberately not committed to `main`.
4. **Publish:** `pnpm --filter telecode publish --access public` (after `pnpm install` and a green
   `pnpm typecheck && pnpm lint && pnpm test`). Use `pnpm publish`, not bare `npm publish`, so the
   `workspace:*` protocol dependency is rewritten to the published version.
5. **Host the installer:** serve `scripts/install-telecode.sh` at `https://telecode.io/install.sh`
   so `curl -fsSL https://telecode.io/install.sh | bash` works.
6. **Verify on a clean machine:** `npx telecode doctor` (preflight) and `npx telecode` (pairing) with no
   repo checkout.

## Install (post-publish)

```sh
# one-liner
curl -fsSL https://telecode.io/install.sh | bash

# or directly
npm install -g telecode
telecode doctor   # preflight: Node, API key, pairing, relay reachability
telecode          # pair this machine, then control it from any browser
```
