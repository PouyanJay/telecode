# syntax=docker/dockerfile:1
#
# Self-host image for the telecode relay — the control plane that brokers messages between a browser and a
# laptop daemon. It runs the TypeScript relay directly via tsx with ONLY its production dependencies; it
# never bundles the Agent SDK, because the relay must never execute agent work (architecture invariant #2).
#
# Build context is the repo root (see infra/docker-compose.yml) so the pnpm workspace + frozen lockfile
# resolve; `--prod --filter @telecode/relay...` then installs just the relay's runtime subtree
# (relay + @telecode/protocol), excluding the daemon, web, and all dev tooling.
FROM node:22-alpine

# corepack activates the lockfile-pinned pnpm (packageManager in the root package.json).
RUN corepack enable
WORKDIR /repo

COPY . .
RUN pnpm install --frozen-lockfile --prod --filter "@telecode/relay..."

ENV NODE_ENV=production
WORKDIR /repo/apps/relay
EXPOSE 8080

# `start` = tsx src/main.ts; the relay binds 0.0.0.0:$RELAY_PORT (default 8080) and degrades gracefully
# per missing env (auth/repos/push each enable only when their secrets are present).
CMD ["pnpm", "start"]
