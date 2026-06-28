# syntax=docker/dockerfile:1
#
# Production image for the telecode web app (the SvelteKit SSR PWA) — deployed to Azure Container Apps at
# app.telecode.io. Built as a Node server via @sveltejs/adapter-node.
#
# The build context is the repo root so the pnpm workspace + frozen lockfile resolve (web depends on the
# workspace packages @telecode/protocol and @telecode/ui). The image is environment-AGNOSTIC: every config
# value (PUBLIC_* and the server secrets) is read at runtime via SvelteKit's `$env/dynamic/*`, so the same
# image runs in any environment — Container Apps injects the env. No secrets are baked in at build time.

# --- build: full install (dev deps needed for `vite build`), build, then prune to prod deps ---------------
FROM node:22-alpine AS build
RUN corepack enable
# Non-interactive pnpm: the prod-prune below switches the store and would otherwise prompt to purge modules.
ENV CI=true
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @telecode/web build
# Prune node_modules to the web app's production subtree (drops vite/svelte/etc. + other workspaces).
RUN pnpm install --frozen-lockfile --prod --filter "@telecode/web..."

# --- runner: the pruned repo (prod node_modules + the built server) ---------------------------------------
FROM node:22-alpine AS runner
WORKDIR /repo
COPY --from=build /repo /repo

ENV NODE_ENV=production
# adapter-node honors PORT/HOST; Container Apps targets this port. ORIGIN is injected at runtime (the public
# https origin) so SvelteKit's CSRF protection accepts the sign-in form POST behind the ingress proxy.
ENV PORT=3000
WORKDIR /repo/apps/web
EXPOSE 3000

CMD ["node", "build/index.js"]
