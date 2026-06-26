# Self-hosting the relay

The relay is the only piece of telecode that could run on someone else's infrastructure — and it only ever
sees ciphertext + routing metadata (see [threat-model.md](./threat-model.md)). Running your own removes
even the metadata exposure to a third party. The bundle brings up the relay and its Postgres with one
command.

## Prerequisites

- Docker + Docker Compose.

## 1. Configure

```sh
cp infra/.env.example infra/.env
```

Fill in `infra/.env`. The required secrets (generate each with `openssl rand -base64 32`):

| Variable               | Purpose                                                       |
| ---------------------- | ------------------------------------------------------------- |
| `POSTGRES_PASSWORD`    | password for the bundled Postgres                             |
| `CHANNEL_TOKEN_SECRET` | signs short-lived browser channel tokens                      |
| `RELAY_SERVICE_SECRET` | shared secret the web tier presents on server-to-server calls |

Optional features turn on only when their secret is present (the relay logs which are off at startup):

| Variable                                 | Enables                                                            |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `TOKEN_ENCRYPTION_KEY` (base64 32-byte)  | encrypted GitHub-token storage + repo listing in the launch picker |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | web push notifications (`npx web-push generate-vapid-keys`)        |

`infra/.env` is git-ignored — never commit it.

## 2. Run

```sh
docker compose -f infra/docker-compose.yml up
```

This starts Postgres, Redis, applies migrations once (a one-shot `migrate` step), then starts the relay on
`http://localhost:8080` (change the host port with `RELAY_PORT`). Verify it:

```sh
curl -fsS http://localhost:8080/healthz   # → {"status":"ok"}
```

## Hardening for a public relay

The relay is the only publicly reachable piece, so it ships safe to leave running:

- **Rate limiting is on by default** — every HTTP request is limited per client IP (default 300 / minute;
  the pairing endpoints are tighter). The bundle wires Redis automatically so the budget is shared across
  relay instances; a single relay also works without Redis (in-memory fallback).
- **Set `TRUST_PROXY=true` behind a reverse proxy** (the bundle defaults to this). It makes the per-IP
  limit key on the real client from `X-Forwarded-For`. If you set it false while behind a proxy, every
  client shares one budget; if true with no proxy, a client could spoof its IP — match it to your topology.
- **Set `RATELIMIT_ALLOWLIST` to your web tier's egress IP(s).** The web tier calls the relay on behalf of
  every user, so its traffic aggregates under one IP — without exempting it the limiter could throttle your
  whole user base. Tune the budget with `RATELIMIT_MAX` / `RATELIMIT_WINDOW`, or disable entirely (not
  recommended) with `RATELIMIT_DISABLED=true`.

## 3. Point your daemon + browser at it

- **Daemon (the laptop running agents):** point it at your relay with the `--relay-url` flag, e.g.
  `npx telecode --relay-url wss://relay.example.com/ws` (or set `TELECODE_RELAY_URL`; the flag wins). The
  URL must be `ws://` or `wss://`. On first run it prints a pairing code; enter it in the web app to bind
  the device.
- **Web app (the PWA):** set `PUBLIC_TELECODE_RELAY_URL` to the same relay, and — if you enabled push —
  `PUBLIC_VAPID_KEY` to your `VAPID_PUBLIC_KEY`. GitHub OAuth (sign-in + the repo token) is configured in
  the web tier; the relay only stores the resulting token, encrypted, when `TOKEN_ENCRYPTION_KEY` is set.

The web UI is deployed separately from this bundle (it is a static/SSR PWA, not part of the relay image).
For local use, run it with `pnpm --filter web dev` pointed at your relay.

## Notes

- **TLS:** in production, terminate TLS in front of the relay (a reverse proxy) and use `wss://` /
  `https://` URLs — channel and device tokens are bearer credentials.
- **Upgrades:** `docker compose -f infra/docker-compose.yml up --build` rebuilds the relay image and
  re-runs the one-shot migration step before the new relay starts. Data persists in the `telecode-pgdata`
  volume.
- **The relay never executes agents** and never holds private keys — it is a stateless multiplexer plus the
  device/session registry. Agent work stays on your machine.
