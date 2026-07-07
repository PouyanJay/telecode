# Adopted sessions — steer your terminal sessions from anywhere

You don't have to launch a session _from_ telecode for telecode to be useful. Start Claude Code in a
terminal the way you always do, walk away, and the session **appears on your telecode dashboard** — with
a live mirrored transcript, its questions routed to your phone, and its consequential tool calls waiting
for your approval there. Telecode calls these **adopted sessions**; they carry an _"on device"_ pill on
the board.

## What you can do with an adopted session

- **Watch it live.** The transcript mirrors to the browser at the end of every agent turn, end-to-end
  encrypted like everything else.
- **Answer its questions.** When the agent asks something (including multiple choice), you can answer
  from the browser.
- **Approve or deny tool calls.** Consequential actions pause for your decision; a denial can carry a
  note telling the agent what to do instead.
- **Take it over.** When an adopted session ends, _Resume as new_ continues its conversation as a new,
  telecode-owned session — the "started at my desk, finished from the sofa" flow.

## How it works

The daemon integrates with Claude Code through its **hooks**: on first run, telecode registers itself in
`~/.claude/settings.json` (tool-use, session start/end, notification, and stop events). Each hook event
is piped to the local daemon, which mirrors the session out through the relay — sealed, so the relay
sees ciphertext only. No CLI scraping, no polling; if the daemon isn't running, the hooks are inert and
Claude Code behaves exactly as if telecode weren't installed.

## The approval gate follows _your_ rules

Adopted sessions are your own local sessions, so telecode is careful to never get in their way:

- **Your permission mode wins.** A session you run with bypass/auto-accept modes is never gated by
  telecode — it defers entirely to Claude Code.
- **Remote gating only while you're watching.** Consequential tool calls are held for a browser decision
  only when a browser is actually viewing the session. Unwatched sessions fall back to Claude Code's own
  local prompt — an adopted session can never freeze because nobody has the dashboard open.
- **Read-only tools pass** without ceremony.

## Turning it on and off

Adoption is **on by default** and controlled per device:

- **From the web:** Settings → _Adopted sessions_ → the **"Adopt my sessions"** toggle per device, plus
  an **excluded projects** list for repos you never want mirrored. The toggle actually installs/removes
  the hooks on that machine.
- **From the terminal:** `telecode hooks status | install | uninstall`, or set `TELECODE_ADOPT=0` to
  disable adoption entirely. `telecode service uninstall` also removes the hooks, so nothing keeps
  firing after telecode is gone.
- **Check it:** `telecode doctor` reports whether adoption is active and which hooks are installed.

## What adopted sessions won't do

Adopted sessions run in **your checkout**, not a telecode-managed worktree — telecode observes them, it
doesn't own them. So the [branch workflow](./branches-and-changes.md) actions are deliberately refused:
no branch switching, no pushing, no worktree removal, and no in-place follow-up messages into your
terminal's conversation. To continue one from telecode, use _Resume as new_ — the child session is
telecode-owned and fully steerable.

---

**Related:** [Getting started](./getting-started.md) · [Branches, changes & PRs](./branches-and-changes.md) ·
[Threat model](./threat-model.md) (the gate and what the relay can't see).
