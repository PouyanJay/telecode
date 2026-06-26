# Telemetry & privacy

**telecode collects no telemetry by default. Nothing is sent anywhere.**

There is no analytics, no usage tracking, no "phone home", and no third-party telemetry SDK anywhere in
the codebase — not in the web app, the daemon, or the relay. Self-hosting removes even the theoretical
possibility: you run every component.

## Opt-in operational metrics (self-host only)

A relay operator who wants basic capacity signals can opt in by setting `TELECODE_TELEMETRY=on` on the
relay. When enabled:

- Events are **aggregate only** — a connection role (`daemon` / `browser`) and lifecycle
  (`peer_connected` / `peer_disconnected`). That's it.
- Events carry **no identifiers** — no `user_id`, no `device_id`, no channel, no IP.
- Events carry **no session content** — never a prompt, a payload, a diff, or a tool call. The relay
  cannot read those anyway (they are end-to-end encrypted; see [threat-model.md](./threat-model.md)).
- Events go to **your own relay's logs** — the same structured pino stream as everything else, on your
  own infrastructure. **There is no network sink in this codebase**: telecode the project never receives
  anything, and no third-party destination is wired. Sending these events somewhere is your explicit
  choice to build on top.

This is a deliberate design: the privacy default is structural (the telemetry seam is a no-op unless you
opt in), not a setting you have to remember to turn off.

## What this means for the hosted instance

If a hosted telecode instance is ever offered, the same rule holds: it forwards only end-to-end ciphertext
plus routing metadata, and any operational metrics are aggregate and identifier-free. The honest caveat
about relay-visible _routing_ metadata is documented in [threat-model.md](./threat-model.md).
