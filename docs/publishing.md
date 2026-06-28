# Publishing the `telecode` CLI

This is the maintainer runbook for shipping the daemon to npm so that `npx @telecode/cli` and the
one-line installer work on any machine.

**Status: published.** The CLI is live on npm as **`@telecode/cli`** and the wire contract as
**`@telecode/protocol`**. The installed binary is still the `telecode` command (the `bin` name is
independent of the package name), so `npm i -g @telecode/cli` gives you a `telecode` command, and the
`curl | sh` installer hides the scope entirely.

> **Why `@telecode/cli` and not bare `telecode`?** The unscoped `telecode` name on npm is owned by an
> unrelated, abandoned 2017 project, so we can't publish under it. We own the **`@telecode` org**, so
> scoped names are ours and can't be squatted. If the bare name is ever transferred to us, we can
> republish there and keep `@telecode/cli` as an alias.

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
- **Installer** — `scripts/install-telecode.sh` is the `curl | sh` entry point (checks Node ≥ 22, then
  `npm install -g @telecode/cli`). It is self-contained so it can be piped straight from curl.

## The repo keeps the publish manifest reverted

Both packages stay `private: true` with `version: 0.0.0` on `main`, and the daemon keeps its internal
name `@telecode/daemon` (the relay and web reference it under that name). The publish-time manifest
changes are **deliberately not committed** — they're applied locally, used to publish, then reverted.
This keeps `main` clean and acts as an accidental-publish guard.

## Auth: a bypass-2FA token

npm requires 2FA to publish to the public registry. Account 2FA via a **security key** can't produce
the rotating OTP the CLI needs, so publishing uses a **granular access token** instead:

1. npmjs.com → **Access Tokens** → **Generate New Token** → Granular (or Classic → Automation).
2. **Read and write** permission, scoped to the **`@telecode`** org/packages, and **Bypass two-factor
   authentication (2FA)** checked.
3. Store it in `~/.npmrc` (never in the repo or `.env` — npm only reads `.npmrc`):
   ```sh
   npm config set //registry.npmjs.org/:_authToken=npm_YOUR_TOKEN_HERE
   ```

## The publish step

Run from a green tree (`pnpm typecheck && pnpm lint && pnpm test`). Publish **protocol first** — the
daemon depends on it, and `pnpm publish` rewrites the `workspace:*` dependency to the published version.

1. **Bump + unguard `@telecode/protocol`:** set `private: false` and a real `version` (e.g. `0.1.0`).
   ```sh
   pnpm --filter @telecode/protocol publish --access public --no-git-checks
   ```
   (`--no-git-checks` because the temporary manifest edits leave the tree dirty.)
2. **Flip the daemon for publish:** in `packages/daemon/package.json` set `"name": "@telecode/cli"`,
   `"private": false`, and the same `"version"`. Leave the `@telecode/protocol` dependency as
   `workspace:*` — pnpm rewrites it to the published version on pack.
   ```sh
   cd packages/daemon && pnpm publish --access public --no-git-checks
   ```
   Sanity-check the rewrite before/after with `pnpm pack` and inspect the packed `package.json`
   `dependencies` — `@telecode/protocol` must be a real version, never `workspace:*`.
3. **Revert the manifest edits** so `main` stays clean:
   ```sh
   git checkout packages/protocol/package.json packages/daemon/package.json
   ```
4. **Host the installer:** serve `scripts/install-telecode.sh` at `https://telecode.io/install.sh`
   so `curl -fsSL https://telecode.io/install.sh | bash` works.
5. **Verify on a clean machine / empty dir** (npm's edge may cache a stale 404 on a brand-new package
   for a few minutes — query the version-specific manifest, e.g. `npm view @telecode/cli@0.1.0`, to
   confirm the publish landed):
   ```sh
   npm install -g @telecode/cli
   telecode doctor   # preflight: Node, API key, pairing, relay reachability
   ```

## Install (for users)

```sh
# one-liner (once telecode.io/install.sh is hosted)
curl -fsSL https://telecode.io/install.sh | bash

# or directly
npm install -g @telecode/cli
telecode doctor   # preflight: Node, API key, pairing, relay reachability
telecode          # pair this machine, then control it from any browser

# or run without installing
npx @telecode/cli
```
