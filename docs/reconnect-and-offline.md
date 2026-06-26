# Reconnecting & offline behavior

A telecode session lives on **your machine**, not in the browser and not on the relay. The web app is a
window onto it. That single fact explains everything below: closing the window doesn't end the work, and
the connection can drop and recover without losing your place.

## Reopen is a reconnect, never a restart

Close the tab, reload, lock your phone, or open the same session on a second device — none of it stops
the agent. When you come back, the browser **reconnects** to the session still running on your machine and
the daemon **backfills the transcript**, so you pick up exactly where you left off. You'll briefly see
"Reconnecting…" rather than a blank or a new session.

## Transparent reconnect on network blips

Both ends recover on their own — no reload required:

- **The browser** redials the relay with backoff if the connection drops, re-authenticates with a fresh
  channel token, and re-attaches to your open sessions.
- **The daemon** redials the relay the same way and keeps its in-memory session state across the gap, so a
  session keeps running through a brief outage.
- **A new channel token** is minted on every reconnect, so a token that expired while you were away is
  renewed rather than rejected.

This covers flaky Wi-Fi, switching networks, and — via a heartbeat that detects half-open connections —
**laptop sleep/wake**: when your machine wakes, the daemon reconnects and your sessions resume.

## When your machine goes offline

If the daemon disconnects (the laptop slept, lost the network, or the daemon stopped), sessions on that
device are shown as **`OFFLINE / PAUSED`** rather than implying they died. The session list still renders
from the registry. As soon as the machine reconnects, the browser resubscribes and the sessions resume.

## Instant history on the same device

Your browser holds a **non-extractable** identity key, persisted in the browser's local storage
(IndexedDB). Because the key is stable across reloads, reopening telecode on the same device decrypts
recently cached session history **instantly** — without waiting for a fresh key exchange. The key can be
_used_ by the page to decrypt while you're on the origin, but it can never be read out or exfiltrated
(even by injected script). The relay helps here by caching the most recent **ciphertext** frames per
session (it still cannot read them), so a reopen shows recent activity immediately even while the daemon
is mid-reconnect.

## What does _not_ survive

Execution is local by design, and that has one honest cost:

- **A powered-off or fully-restarted daemon.** If the daemon process stops (reboot, quit, crash), the
  in-memory transcript for a running session is gone — the work was happening on that machine. The session
  list still shows the session from the registry, but it can't be resumed until you launch again. Surviving
  a fully powered-off laptop would require handing execution off elsewhere, which telecode deliberately
  does not do.

In short: brief drops, reloads, and sleep/wake are transparent; only the machine itself going away ends a
running session.
