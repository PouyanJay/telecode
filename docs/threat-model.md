# Threat model

Telecode runs coding agents on **your** machine and lets you drive them from a browser. The relay is only
a meeting point: both your laptop (the daemon) and your browser dial _out_ to it, and it forwards messages
between them. This document states plainly what each part can and cannot see, and how you can verify it.

## Two boundaries

**1. The approval gate is the execution boundary.** The daemon runs code on your machine. Every
consequential tool call the agent wants to make is paused at the SDK permission gate and forwarded to your
browser as an `agent.permission_request`; nothing runs until you allow it. The default permission mode is
conservative. A compromised account is therefore a serious event — prefer scoped repositories and keep the
default gate on.

**2. End-to-end encryption is the confidentiality boundary.** Session content — your prompts, the agent's
output, tool inputs, diffs, and the backfilled transcript — is encrypted in the browser and the daemon and
**only ever passes through the relay as ciphertext**. The relay holds no private keys and cannot read it.

## How the encryption works

- Each **device** (daemon) generates an X25519 keypair on first run and registers its _public_ key with
  the relay at pairing. The private key never leaves the laptop (`~/.telecode/credentials.json`).
- Each **browser** session generates an ephemeral X25519 keypair (in memory, regenerated per page load).
- On launch, the browser seals the prompt to the daemon's public key (`box`) and announces its own public
  key. The daemon decrypts it, mints a per-session symmetric **content key**, and delivers that key wrapped
  to the browser's public key (`session.key`).
- Every subsequent session message — in both directions — is encrypted under the content key
  (`secretbox`). One encrypted frame fans out to every browser tab watching the session.
- All crypto lives in `packages/protocol` (libsodium-family primitives via `tweetnacl`); no component
  encrypts ad hoc.

## What the relay can and cannot see

| The relay **sees** (routing metadata)                                           | The relay **never sees**                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------- |
| That a session exists; its id, owning user + device                             | Your prompts                                   |
| Timing and approximate message sizes                                            | The agent's output, messages, diffs            |
| Message `type` (e.g. `agent.message`, `session.ended`)                          | Tool names and tool inputs                     |
| Lifecycle `status` (`running` / `awaiting_input` / `done` / `error` / `paused`) | The session transcript                         |
| Public keys (they are public by definition)                                     | Any private key or the per-session content key |

**Honest caveat:** this metadata exposure is real and is _not_ encrypted in v1 — full metadata privacy
(hiding existence, timing, and sizes) is out of scope. If you need to remove even that exposure to a third
party, **run your own relay** (see the self-hosting guide); then the only party that sees the metadata is
you.

## Verifying it yourself

The guarantee is enforced by tests and is observable in the relay's own logs.

- **Automated:** `apps/relay/tests/integration/e2e-session.test.ts` runs a full encrypted session across a
  real relay and a real daemon and asserts (a) every frame the relay forwards carries a ciphertext payload
  with no plaintext, and (b) the relay's logs contain no plaintext and no payload at all. Run it with
  `pnpm --filter @telecode/relay test -- e2e-session`.

- **By hand:** start the stack with `make run`, launch a session from the browser, then inspect the relay's
  log:

  ```sh
  # Session payloads are ciphertext; the relay logs only routing metadata (ids, type, status) — never a
  # prompt, agent message, or a `payload` field.
  grep -i 'payload\|prompt' .run-state/relay.log    # → no session content
  ```

  You will see lines like `relay: session running` / `relay: session ended` carrying ids and status, but
  no message text. On the wire, every session frame's `payload` is a base64 ciphertext string.

## Known limitations (v1)

- **Relay-brokered key exchange.** The relay relays public keys between browser and daemon. A malicious
  relay could attempt a man-in-the-middle by substituting keys. The daemon's key is registered over TLS at
  pairing and stored server-side, and connections use WSS, but out-of-band key verification is not yet
  implemented. Self-hosting removes the untrusted-relay assumption entirely.
- **Browser keys are ephemeral.** A browser regenerates its keypair each page load, so it cannot decrypt
  history that was encrypted to a previous key; on reconnect the daemon re-delivers the content key and
  re-sends the transcript. Persisting browser keys (IndexedDB) for instant same-device reload is planned.
- **A powered-off laptop cannot run agents.** Execution is local by design; if the daemon is offline, the
  session list still renders from the registry but the session is paused until the laptop reconnects.
