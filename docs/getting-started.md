# Getting started

This guide takes you from nothing to your first remote agent session in a few minutes. You'll run a
daemon on the machine you want to control, pair it to your account, and launch a session you can steer
from any browser.

## What you need

- The **machine you want to control** (your laptop/workstation), with **Node.js 22+**.
- An **`ANTHROPIC_API_KEY`** available to the daemon — needed to **launch** sessions from the web. (If
  you only want telecode to mirror sessions you start locally with Claude Code — see
  [adopted sessions](./adopted-sessions.md) — no key is needed; Claude Code brings its own auth.)
- A **browser** — on the same machine or a different one (your phone works; the web app is responsive
  and mobile-first).

## 1. Install and run the daemon

On the machine you want to control:

```sh
# one-line install (checks Node 22+, installs the telecode command)
curl -fsSL https://telecode.io/install.sh | bash

# …or straight from npm
npm install -g @telecode/cli    # then: telecode
npx @telecode/cli               # or run it without installing
```

On first run the daemon generates its keypair, prints a **pairing code**, and waits to be bound to your
account:

```
telecode pairing
  code: XXXX-XXXX
  approve at: https://app.telecode.io/activate
  expires in 5 minutes
```

(Self-hosting the relay? Point the daemon at yours with `--relay-url wss://relay.example.com/ws` — see
[self-hosting](./self-hosting.md).)

### Preflight with `telecode doctor`

`telecode doctor` reports, in one screen, whether this machine can run an agent: Node version, API key,
pairing, relay reachability, whether the background service is installed, and whether session adoption
is active. A failing check explains how to fix it; warnings (like "not paired yet" on a fresh install)
don't block anything. A missing `ANTHROPIC_API_KEY` is only a problem if you want to launch sessions
from the web.

## 2. Pair the machine

1. Open the web app and **sign in**.
2. Enter the pairing code the daemon printed on the activation page.
3. The machine appears as a paired device and connects within a second or two.

Pairing binds the device to your account with a scoped, revocable token ([how that works](./connecting-your-machine.md)).
The daemon's private key never leaves the machine. If you ever **revoke** a device, its daemon re-pairs
with a fresh code — one approval re-authorizes the _same_ device, with its session history intact.

## 3. Keep it running in the background

After pairing, the daemon offers to install itself as a **login service** (launchd on macOS, a systemd
user unit on Linux) so it's always on — starts at login, restarts on crash, no terminal to babysit.
Accept the offer, or manage it yourself any time:

```sh
telecode service install     # install + start the login service
telecode service status      # installed? running? starts at login?
telecode service logs        # tail the daemon log
telecode service stop        # stop until next login or `service start`
telecode service uninstall   # remove the service (and telecode's Claude Code hooks)
```

On Windows the background service isn't available yet — run `telecode` in a terminal for now.

## 4. Launch and steer a session

1. From the dashboard, open **Launch session** (`⌘N`). Describe the task, then tune the run to taste —
   every option is optional:
   - **Run on** — pick which paired machine runs it (when you have more than one).
   - **Repository** — pick a GitHub repo to run in, or use the daemon's default workspace.
   - **Base branch** and an optional **branch name** — a session launched in a repository works on its
     **own new branch**, cut from the base you pick (auto-named from the task if you don't). See
     [Branches, changes & PRs](./branches-and-changes.md).
   - **Permission mode** — _Plan only_, _Approve edits_ (the default: you approve each consequential
     action), or _Auto-accept edits_.
2. Watch the agent work in the **transcript**: messages, collapsible tool calls, and syntax-highlighted
   diffs stream in live. The **Changes** panel keeps a running diff of the session's branch against its
   base.
3. When the agent wants to do something consequential, it **pauses for your approval**. Review the diff
   or command and **Approve** or **Reject** (optionally with a note telling it what to do instead).
   Nothing runs until you decide.
4. **Steer** at any time by sending a follow-up message. **Interrupt** stops the current turn (the
   session stays followable — just send another message to continue); **End** terminates it.
5. Happy with the result? **Push the branch** from the session view and open a pull request. Or keep
   going — a finished session accepts follow-ups, and can even switch its worktree to another branch
   between turns. A session that can't continue in place (say, the daemon restarted mid-run) offers
   **Resume as new**, which forks the conversation into a fresh linked session — optionally onto a new
   branch.

You can close the tab and come back later — reopening **reconnects** to the session running on your
machine, it does not restart it. See [Reconnecting & offline behavior](./reconnect-and-offline.md).

## Sessions you start in a terminal

Telecode also mirrors Claude Code sessions you start **locally** (outside telecode) — they appear on the
dashboard with an _on device_ pill, and you can answer their questions and approve their tool calls from
your phone. This is on by default and controlled per device from Settings. Read
[Adopted sessions](./adopted-sessions.md).

## Notifications

Enable browser notifications from Settings to get pinged the moment a session needs your input — so you
don't have to watch it run. Notifications carry only routing metadata (which session needs you), never
prompt or code content.

## Where to next

- [Branches, changes & PRs](./branches-and-changes.md) — the branch-per-session model, reviewing the
  diff, switching branches, pushing, and opening PRs.
- [Adopted sessions](./adopted-sessions.md) — steering locally-started Claude Code sessions from the
  browser.
- [Reconnecting & offline behavior](./reconnect-and-offline.md) — reloads, network drops, laptop sleep.
- [Self-hosting the relay](./self-hosting.md) — run the relay yourself so even routing metadata stays
  with you.
- [Threat model](./threat-model.md) — exactly what each part can and cannot see.
