# Getting started

This guide takes you from nothing to your first remote agent session in a few minutes. You'll run a
daemon on the machine you want to control, pair it to your account, and launch a session you can steer
from any browser.

## What you need

- The **machine you want to control** (your laptop/workstation), with **Node.js 22+** and an
  `ANTHROPIC_API_KEY` available to it.
- A **browser** — on the same machine or a different one (your phone works; the web app installs as a
  PWA).

## 1. Run the daemon

On the machine you want to control, start the telecode daemon. It generates a keypair on first run,
prints a **pairing code**, and then waits to be bound to your account.

> **Note:** the published `telecode` command isn't on npm yet. Until it ships, run the daemon from a clone
> of this repository with `make run` (which starts the relay, the daemon, and the web app together) and
> read the pairing code from `.run-state/daemon.log`. Once published, the command below is all you need.

```sh
telecode          # prints a pairing code and waits
telecode doctor   # optional preflight — see below
```

### Preflight with `telecode doctor`

`telecode doctor` reports, in one screen, whether this machine can run an agent:

```
telecode doctor

  ✓  Node.js: v22.4.0 (>= 22 required)
  ✓  Anthropic API key: ANTHROPIC_API_KEY is set
  !  Device pairing: not paired yet — run `telecode` to pair this device
  ✓  Relay reachability: reachable at ws://127.0.0.1:8080/ws

All checks passed.
```

A failing check explains how to fix it; a warning (like "not paired yet") is fine on a fresh install.

## 2. Pair the machine

1. Open the web app and **sign in**.
2. The first-run screen walks you through two steps. On **Pair your machine**, enter the pairing code the
   daemon printed (or, in a local clone, the code from `.run-state/daemon.log`).
3. The machine appears as a paired device and connects within a second or two.

Pairing binds the device to your account with a scoped, revocable token. The daemon's private key never
leaves the machine.

## 3. Launch and steer a session

1. From the dashboard, describe a task in the launch box and press **Launch** (`⌘/Ctrl + Enter`).
   Optionally pick a GitHub repository to run in.
2. Watch the agent work in the **transcript**: messages, collapsible tool calls, and syntax-highlighted
   diffs stream in live.
3. When the agent wants to do something consequential, it **pauses for your approval**. Review the diff
   or command and **Approve** or **Reject**. Nothing runs until you decide.
4. **Steer** at any time by sending a follow-up message. **Interrupt** stops the current turn (the session
   stays followable — just send another message to continue); **End** terminates it.

You can close the tab and come back later — reopening **reconnects** to the session running on your
machine, it does not restart it. See [Reconnecting & offline behavior](./reconnect-and-offline.md).

## Notifications

Enable browser notifications from the dashboard to get pinged the moment a session needs your input — so
you don't have to watch it run.

## Where to next

- [Reconnecting & offline behavior](./reconnect-and-offline.md) — reloads, network drops, laptop sleep.
- [Self-hosting the relay](./self-hosting.md) — run the relay yourself so even routing metadata stays with
  you.
- [Threat model](./threat-model.md) — exactly what each part can and cannot see.
