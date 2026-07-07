# Branches, changes & PRs

Telecode is built for running **several agents against the same repository at once** — and for reviewing
and shipping what they produce from wherever you are. The mechanism is simple: **every session launched
in a repository gets its own git worktree and its own new branch**, so parallel sessions never trample
each other, and each session's work stays inspectable, pushable, and disposable as a unit.

This page covers the whole lifecycle: how the branch is cut, reviewing the diff, switching branches,
forking a session onto a new branch, pushing for a PR, and cleaning up.

## A branch per session

When you launch a session in a repo, the daemon cuts a dedicated worktree (under `~/.telecode/worktrees/`)
on a **fresh branch**:

- **The base is yours to pick.** The launch drawer lists the repo's branches; the session's branch is cut
  from the one you choose (default: the repo's HEAD). The branch list travels end-to-end encrypted, like
  all session content.
- **The name is readable.** Auto-named `telecode/<task-slug>-<short-id>` from your first instruction, or
  type your own in the launch drawer.
- **It's visible everywhere.** The session header and the rail show the repo and branch, so you always
  know where a session's work lives.

Sessions launched with **no repository** run in the daemon's default workspace without a worktree — the
branch features on this page apply to repo-backed sessions.

## Reviewing: the Changes panel

The session rail's **Changes** panel shows the session branch's **real diff against its base** — files
changed with per-file `+/−` counts, updated as the agent works. It's the "what did this session actually
do to the code" view, designed to be reviewable from a phone before you decide to ship or discard.

The comparison base stays the branch you launched from, even if you later switch the worktree onto
another branch — so the panel always answers "what has this session produced since it started".

## Shipping: push & open a PR

When a session has settled (finished, errored, or hit its turn limit), the session view offers
**Push branch for a PR**:

1. The **daemon** pushes the session branch to `origin` — using the **laptop's own git credentials**
   (your SSH agent or credential helper). Telecode adds no token of its own; neither the relay nor the
   daemon ever holds GitHub credentials for this.
2. The **browser** then offers **"Open a pull request"** — a link straight to the GitHub compare page for
   `base...session-branch`, opened in your own signed-in browser. For a non-GitHub remote, the branch is
   pushed and you open the PR from your git host.

## Steering mid-flight

- **Switch branch (between turns).** While a launched session is idle after a finished turn, you can
  check its worktree out onto another existing branch before sending the next instruction — useful for
  "now do the same on the release branch". A worktree with uncommitted changes refuses to switch (nothing
  is ever moved out from under the agent's feet).
- **Fork onto a new branch.** When a session can't continue in place (for example, the daemon restarted
  mid-run), _Resume as new_ starts a **linked child session that keeps the conversation** — and can cut
  it a fresh worktree and branch. The default base is the parent session's own branch, so "fork" means
  exactly that: continue this conversation _and_ this code state, on a branch of its own. Pick any other
  base to replay the conversation against different code.

## Cleaning up

Worktrees and branches are never removed automatically — ending a session leaves its work on disk.
Cleanup is explicit: when you delete an ended session, the delete dialog offers
**"Also remove its worktree and branch"**.

- A worktree with **uncommitted changes refuses to be reaped** — the delete is cancelled and the session
  kept, so nothing half-done is ever lost silently. Commit or discard on the device first, or delete
  without removing the worktree.
- **Committed-but-unpushed work on the branch is discarded** — that's precisely what the checkbox opts
  into. Push first if you want to keep it.

## Adopted sessions are different — on purpose

Sessions telecode **adopts** from your own terminal run in _your_ checkout, not a telecode-managed
worktree. So branch switch, push, and worktree removal are deliberately refused for them: telecode
observes and gates an adopted session, but your working copy publishes on your own terms. See
[Adopted sessions](./adopted-sessions.md).

---

**Related:** [Getting started](./getting-started.md) (the launch drawer) ·
[Adopted sessions](./adopted-sessions.md) · [Threat model](./threat-model.md) (why the relay sees none
of this — branch names and diffs included).
