import { z } from 'zod';

/**
 * Payload schemas for the session lifecycle messages (web ⇄ daemon, via the relay). These define the
 * plaintext shape carried in `Envelope.payload`; in E2E mode (Phase 3) the same shape is encrypted, so
 * the relay never reads them — it routes on envelope metadata alone. Tightly-coupled sibling schemas
 * live together here by design.
 */

/**
 * A 32-byte key (X25519 public key or symmetric content key) as standard base64 — the wire/storage shape
 * produced by `encodeKey`. 32 bytes encode to exactly 44 base64 characters (43 data chars + one `=` pad).
 * Validating here, at the trust boundary, rejects malformed key material before it reaches `decodeKey`
 * (where a non-base64 string would otherwise throw a cryptic `atob` error deep in the crypto path).
 */
export const base64KeySchema = z
  .string()
  .length(44)
  .regex(/^[A-Za-z0-9+/]{43}=$/, 'must be a base64-encoded 32-byte key');
export type Base64Key = z.infer<typeof base64KeySchema>;

/** The Agent SDK permission modes, surfaced on the wire. Default is the conservative `default`. */
export const permissionModeSchema = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
export type PermissionModeName = z.infer<typeof permissionModeSchema>;

/**
 * A safe path segment for a repo owner/name: it becomes part of the daemon's on-disk clone cache path
 * (`~/.telecode/repos/<owner>/<name>`), so it is constrained to GitHub-valid characters and may not be a
 * traversal segment (`.`/`..`) — validated at the wire boundary so a crafted launch can't escape the cache.
 */
export const repoPathSegmentSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((value) => value !== '.' && value !== '..', {
    message: 'must not be a traversal segment',
  });

/**
 * Payload for the `repo` a session runs in (Phase 2 Task 8): the daemon clones it on demand (using the
 * laptop's own git credentials — the relay's GitHub token never travels here) and cuts the session's
 * worktree from it. `cloneUrl` is the repo's public clone URL (from the repo listing).
 */
export const sessionRepoSchema = z.object({
  owner: repoPathSegmentSchema,
  name: repoPathSegmentSchema,
  cloneUrl: z.string().min(1).max(500),
});
export type SessionRepo = z.infer<typeof sessionRepoSchema>;

/** The most branches one `repo.branches.state` carries — shared so the daemon's cap and the wire
 * bound can never drift. */
export const MAX_REPO_BRANCHES = 500;

/** The longest branch name any wire field accepts — shared for the same no-drift reason. */
export const MAX_BRANCH_NAME_CHARS = 256;

/**
 * A wire-provided git branch name (branch-launch Phase B). A conservative ref-name subset validated at
 * the trust boundary — these reach `git` argv on the daemon (always via execFile array-args; this is
 * defense on top): no whitespace/control chars, no `..`, none of git's forbidden ref characters, no
 * leading `-` (option injection) or `/`, no trailing `/`, `.` or `.lock`.
 */
const gitBranchNameSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_NAME_CHARS)
  .refine(
    (name) =>
      // eslint-disable-next-line no-control-regex -- excluding control chars IS the point here
      !/[\s~^:?*[\\\x00-\x1f\x7f]/.test(name) &&
      !name.includes('..') &&
      !name.includes('@{') &&
      !name.startsWith('-') &&
      !name.startsWith('/') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.endsWith('.lock'),
    { message: 'not a valid git branch name' },
  );

/** Whether a string is launch-safe as a git branch name — the drawer's inline validation shares the
 * exact wire rule so the two can never disagree. */
export function isValidGitBranchName(name: string): boolean {
  return gitBranchNameSchema.safeParse(name).success;
}

/** Payload for `session.launch` (web → daemon): parameters to start one new agent session. */
export const sessionLaunchPayloadSchema = z.object({
  prompt: z.string().min(1),
  /** GitHub repo to clone-on-demand and run in; omitted runs in the daemon's configured/default cwd. */
  repo: sessionRepoSchema.optional(),
  /** Existing branch to cut the session branch FROM (Phase B); omitted → the repo's HEAD. */
  baseBranch: gitBranchNameSchema.optional(),
  /** The new session branch's name (Phase B); omitted → the telecode auto-name. */
  branchName: gitBranchNameSchema.optional(),
  /** Working directory for the session (single cwd in Phase 1; git worktrees in Phase 2). */
  cwd: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
  /** Optional user-facing label. */
  title: z.string().min(1).optional(),
  /**
   * Client-generated correlation id, echoed back on `session.started`, so the launching browser can
   * match the relay-minted `session_id` to *its* launch (the relay assigns the id; the browser can't
   * choose it). Opaque to the relay.
   */
  clientRef: z.string().min(1).optional(),
});
export type SessionLaunchPayload = z.infer<typeof sessionLaunchPayloadSchema>;

/**
 * Payload for `session.resume_new` (web → daemon, ux Phase 6 T8): continue a TERMINAL session as a NEW
 * linked one. The envelope's `session_id` names the PARENT (routing + link); `prompt` seeds the child's
 * first turn; `clientRef` rides the child's `session.started` so the acting browser can navigate to it,
 * exactly like a launch. Sealed like `session.launch` (box-sealed to the daemon) — never under the
 * parent's content key, which a needs_restart parent may no longer have.
 */
export const sessionResumeNewPayloadSchema = z.object({
  prompt: z.string().min(1),
  clientRef: z.string().min(1).optional(),
  /**
   * Fork onto a chosen branch (branch-actions T5): cut the CHILD a fresh worktree from this base
   * (default: the parent's own branch, so the fork continues from the parent's code state) with
   * this name (default: the telecode auto-name). Omitting BOTH keeps the pre-T5 behavior — the
   * child inherits the parent's worktree. Validated like the launch's fields (they reach git argv).
   */
  baseBranch: gitBranchNameSchema.optional(),
  branchName: gitBranchNameSchema.optional(),
});
export type SessionResumeNewPayload = z.infer<typeof sessionResumeNewPayloadSchema>;

/**
 * Payload for `session.started` (daemon → web): the session is now running. The id is on the envelope;
 * `clientRef` echoes the launch's correlation id so the launching browser can pair its request to the id.
 */
export const sessionStartedPayloadSchema = z.object({ clientRef: z.string().optional() });
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>;

/**
 * How a session came to exist, mirroring the `sessions.origin` column.
 *  - `launched` — started from telecode (a browser `session.launch`; the daemon drives it via the SDK).
 *  - `external` — a Claude Code session the user started themselves (terminal / IDE) that telecode
 *    **adopted** through the hooks bridge. telecode monitors + gates it but does not own its run loop.
 * Defaults to `launched` everywhere so the registry stays backward-compatible.
 */
export const SESSION_ORIGINS = ['launched', 'external'] as const;
export const sessionOriginSchema = z.enum(SESSION_ORIGINS);
export type SessionOrigin = z.infer<typeof sessionOriginSchema>;

/**
 * Payload for `session.adopted` (daemon → relay → browser): the daemon announces an externally-started
 * Claude Code session it discovered via the hooks bridge, so the relay mints a registry row
 * (`origin: 'external'`) and the dashboard surfaces it. `clientRef` is the daemon's own correlation token
 * (the Claude `session_id`); the relay echoes it back with the minted telecode `session_id` so the daemon
 * can pair its hook events to that id — the same correlation pattern as `session.launch` → `session.started`,
 * but daemon-initiated. `title`/`cwd` are derived hints for the row (first prompt / working directory).
 */
export const sessionAdoptedPayloadSchema = z.object({
  clientRef: z.string().min(1).max(256),
  // Bounded so a buggy/compromised daemon can't grow the registry row or the broadcast unboundedly.
  title: z.string().min(1).max(512).optional(),
  cwd: z.string().min(1).max(1024).optional(),
});
export type SessionAdoptedPayload = z.infer<typeof sessionAdoptedPayloadSchema>;

/**
 * The per-machine adoption policy (Journey 3), managed from the web and applied by the daemon at runtime:
 *  - `enabled` — the master switch for adopting externally-started Claude Code sessions.
 *  - `denylist` — project paths to NEVER adopt/mirror (a session whose `cwd` is under one of these is left
 *    entirely to Claude Code's own local flow). Allow-all by default; the denylist is the privacy carve-out.
 * Bounded so a compromised peer can't bloat it.
 */
export const adoptSettingsSchema = z.object({
  enabled: z.boolean(),
  denylist: z.array(z.string().min(1).max(1024)).max(100),
});
export type AdoptSettings = z.infer<typeof adoptSettingsSchema>;

/**
 * Payload for `adopt.config` (web → daemon, Journey 3): the device's adoption policy, **box-sealed to the
 * daemon's key** so the relay never sees repo paths (invariant #5). `set` present updates + persists the
 * policy; `set` omitted is a read-only request. Either way the daemon replies {@link adoptStatePayloadSchema}
 * sealed to the requesting browser. The envelope carries the browser's `sender_public_key` for that reply.
 */
export const adoptConfigPayloadSchema = z.object({ set: adoptSettingsSchema.optional() });
export type AdoptConfigPayload = z.infer<typeof adoptConfigPayloadSchema>;

/**
 * Payload for `adopt.state` (daemon → web): the current adoption policy PLUS the setup status, so the web
 * can represent frictionless setup honestly. It extends {@link adoptSettingsSchema} with:
 *  - `hooksInstalled` — whether telecode's Claude Code hooks are actually installed in `~/.claude/settings.json`
 *    (the daemon auto-installs them on start when adoption is enabled). This is what tells the UI "active"
 *    vs "setting up / not wired up" — distinct from `enabled` (the user's intent).
 *  - `events` — which hook events are installed (e.g. PreToolUse, SessionStart, …, Stop), for display.
 * Box-sealed to the browser like the policy itself (invariant #5), so hook paths/denylist never reach the relay.
 */
export const adoptStatePayloadSchema = adoptSettingsSchema.extend({
  hooksInstalled: z.boolean(),
  // The installed hook-event names. Today there are 5 (PreToolUse/SessionStart/SessionEnd/Notification/Stop);
  // `.max(20)` is generous headroom so a future Claude Code hook type doesn't need a wire bump, while still
  // bounding the encrypted frame.
  events: z.array(z.string().min(1).max(64)).max(20).default([]),
});
export type AdoptStatePayload = z.infer<typeof adoptStatePayloadSchema>;

/**
 * Payload for `repo.branches` (web → daemon): ask for the default repo's branches (Phase B), or —
 * with `sessionId` (branch-actions T4) — for the branches of THAT launched session's own repo (the
 * rail's Switch picker and the fork drawer's base list). Additive optional: old peers only ever ask
 * the default form.
 */
export const repoBranchesRequestPayloadSchema = z.object({
  sessionId: z.string().uuid().optional(),
});
export type RepoBranchesRequestPayload = z.infer<typeof repoBranchesRequestPayloadSchema>;

/**
 * Payload for `repo.branches.state` (daemon → web, sealed to the requester): the asked repo's
 * local branches. `available: false` = nothing to list (no default repo configured, or an unknown/
 * repo-less session). `sessionId` echoes a session-scoped ask so the browser can key the answer to
 * the asking surface; absent on the Phase B default-repo form. Bounded like the launch's branch
 * fields; the daemon caps the list before sealing.
 */
export const repoBranchesStatePayloadSchema = z.object({
  available: z.boolean(),
  branches: z.array(z.string().min(1).max(MAX_BRANCH_NAME_CHARS)).max(MAX_REPO_BRANCHES),
  defaultBranch: z.string().min(1).max(256).optional(),
  sessionId: z.string().uuid().optional(),
});
export type RepoBranchesStatePayload = z.infer<typeof repoBranchesStatePayloadSchema>;

/**
 * Payload for `workspace.reap` (web → daemon, branch-actions T3): the delete flow's explicit opt-in
 * to remove a launched session's worktree + branch on its device. Box-sealed device-scoped like
 * `adopt.config`. The id must be a real UUID — it is matched against the daemon's records, never
 * used as a path, but the boundary stays strict anyway.
 */
export const workspaceReapRequestPayloadSchema = z.object({
  sessionId: z.string().uuid(),
});
export type WorkspaceReapRequestPayload = z.infer<typeof workspaceReapRequestPayloadSchema>;

/**
 * Why a reap was refused: the daemon doesn't know the session (`unknown-session`), it isn't a
 * reapable one (`not-reapable` — adopted, still running, or holding no worktree), the tree has
 * uncommitted work (`dirty` — never silently discarded), or git failed (`failed` — the generic
 * story; git stderr can carry local paths, so it never travels).
 */
export const WORKSPACE_REAP_FAILURE_CODES = [
  'unknown-session',
  'not-reapable',
  'dirty',
  'failed',
] as const;
export const workspaceReapFailureCodeSchema = z.enum(WORKSPACE_REAP_FAILURE_CODES);
export type WorkspaceReapFailureCode = z.infer<typeof workspaceReapFailureCodeSchema>;

/**
 * Payload for `workspace.reap.state` (daemon → web, sealed to the requester): success carries no
 * code; a refusal always carries one, so the UI never has to invent a story.
 */
export const workspaceReapStatePayloadSchema = z.union([
  z.object({ sessionId: z.string().uuid(), ok: z.literal(true) }),
  z.object({
    sessionId: z.string().uuid(),
    ok: z.literal(false),
    code: workspaceReapFailureCodeSchema,
  }),
]);
export type WorkspaceReapStatePayload = z.infer<typeof workspaceReapStatePayloadSchema>;

/**
 * Payload for `session.branch.switch` (web → daemon, branch-actions T4): move a LAUNCHED session's
 * worktree onto another EXISTING branch between turns. Sealed under the session content key like
 * every session-scoped command; the branch name is validated at the boundary (it reaches git argv).
 */
export const sessionBranchSwitchPayloadSchema = z.object({
  branch: gitBranchNameSchema,
});
export type SessionBranchSwitchPayload = z.infer<typeof sessionBranchSwitchPayloadSchema>;

/**
 * Why a switch was refused: a turn is in flight (`mid-turn` — never move the tree under the agent),
 * the session can't take follow-ups anymore (`ended`), it isn't a telecode-launched worktree session
 * (`not-launched` — adopted checkouts are display-only by design), the tree has uncommitted work
 * (`dirty`), the branch doesn't exist locally (`not-found`), git refused because another worktree
 * holds it (`checked-out-elsewhere` — usually the user's own working copy), or git failed
 * (`failed`, the generic story — stderr can carry local paths).
 */
export const BRANCH_SWITCH_FAILURE_CODES = [
  'mid-turn',
  'ended',
  'not-launched',
  'dirty',
  'not-found',
  'checked-out-elsewhere',
  'failed',
] as const;
export const branchSwitchFailureCodeSchema = z.enum(BRANCH_SWITCH_FAILURE_CODES);
export type BranchSwitchFailureCode = z.infer<typeof branchSwitchFailureCodeSchema>;

/**
 * Payload for `session.branch.state` (daemon → web, sealed under the session content key): how the
 * switch settled. Success names the branch actually checked out; a refusal always carries a code.
 * The daemon also re-emits `session.meta` (new branch) and `session.changes` on success — this
 * frame exists so the ASKING surface can settle its in-flight control.
 */
export const sessionBranchStatePayloadSchema = z.union([
  z.object({ ok: z.literal(true), branch: z.string().min(1).max(MAX_BRANCH_NAME_CHARS) }),
  z.object({ ok: z.literal(false), code: branchSwitchFailureCodeSchema }),
]);
export type SessionBranchStatePayload = z.infer<typeof sessionBranchStatePayloadSchema>;

/** Payload for `session.push` (web → daemon, branch-actions T6): push the session branch to origin. */
export const sessionPushRequestPayloadSchema = z.object({});
export type SessionPushRequestPayload = z.infer<typeof sessionPushRequestPayloadSchema>;

/**
 * Why a push was refused: not a telecode-launched worktree session (`not-launched`), a turn is in
 * flight (`mid-turn` — never publish a state the agent is mid-way through writing), the repo has no
 * `origin` (`no-remote`), the laptop's own git credentials were refused (`auth`), the remote
 * refused the ref (`rejected` — non-fast-forward), the push ran out of time (`timeout`), or git
 * failed some other way (`failed` — generic; stderr can carry local paths and never travels).
 */
export const PUSH_FAILURE_CODES = [
  'not-launched',
  'mid-turn',
  'no-remote',
  'auth',
  'rejected',
  'timeout',
  'failed',
] as const;
export const pushFailureCodeSchema = z.enum(PUSH_FAILURE_CODES);
export type PushFailureCode = z.infer<typeof pushFailureCodeSchema>;

/**
 * Payload for `session.push.state` (daemon → web, sealed under the session content key): how the
 * push settled. Success names the pushed branch, the base NAME a compare URL wants (remote prefix
 * stripped; absent when the base is a bare commit id), and `owner/name` when origin is a
 * github.com remote — from these the BROWSER builds and opens the PR page itself.
 */
export const sessionPushStatePayloadSchema = z.union([
  z.object({
    ok: z.literal(true),
    branch: z.string().min(1).max(MAX_BRANCH_NAME_CHARS),
    base: z.string().min(1).max(MAX_BRANCH_NAME_CHARS).optional(),
    githubRepo: z.string().min(1).max(256).optional(),
  }),
  z.object({ ok: z.literal(false), code: pushFailureCodeSchema }),
]);
export type SessionPushStatePayload = z.infer<typeof sessionPushStatePayloadSchema>;

/** Session lifecycle states; mirrors the `sessions.status` column. */
export const SESSION_STATUSES = [
  'starting',
  'running',
  'awaiting_input',
  'done',
  'error',
  // The device is off, so the session can't run; it resumes when the daemon reconnects.
  'offline_paused',
  // The run stopped early because it exhausted its turn budget (ux Phase 6, B5 "Ended — turn limit"),
  // NOT because the agent finished or failed — a follow-up message continues the same conversation.
  'turn_limit',
  // The daemon no longer holds this session's conversation (it restarted, or the row was retired by
  // reconcile), so follow-ups can't resume it in place (ux Phase 6, B5 "Needs restart").
  'needs_restart',
] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatusName = z.infer<typeof sessionStatusSchema>;

/**
 * Payload for `device.presence` (relay → web): whether the daemon behind the channel is currently
 * connected. The relay broadcasts it when a daemon registers/disconnects so a watching browser flips its
 * live sessions to `offline_paused` (offline) or resubscribes to resume them (online) — no reload.
 */
export const devicePresencePayloadSchema = z.object({ online: z.boolean() });
export type DevicePresencePayload = z.infer<typeof devicePresencePayloadSchema>;

/**
 * Payload for `relay.error` (relay → web): a browser frame could not be delivered. `code` names why
 * (only `device_offline` today); `regarding` is the message type of the frame that failed, so the UI
 * can un-spin exactly the action that went nowhere (a decision, an answer, a follow-up…) instead of
 * pretending it was acted on. Relay-generated cleartext routing metadata — never a session payload.
 */
export const relayErrorPayloadSchema = z.object({
  code: z.enum(['device_offline']),
  regarding: z.string().min(1),
});
export type RelayErrorPayload = z.infer<typeof relayErrorPayloadSchema>;

/**
 * Payload for `viewer.presence` (relay → daemon): the mirror of `device.presence`. Whether ANY browser is
 * currently connected on the daemon's channel. The relay sends it when the browser count crosses 0↔1 (and
 * once on daemon registration), so the daemon knows whether a remote operator is present to approve a tool
 * — an adopted session only holds a consequential tool for a remote decision when `online` is true;
 * otherwise it defers to Claude Code's own local prompt rather than freezing an unwatched local session.
 */
export const viewerPresencePayloadSchema = z.object({ online: z.boolean() });
export type ViewerPresencePayload = z.infer<typeof viewerPresencePayloadSchema>;

/**
 * Payload for `session.reconcile` (daemon → relay): the ids of the sessions the daemon currently holds in
 * memory. Sent on every (re)registration so the relay can retire any OTHER non-terminal session for the
 * device that is stale in the registry (a session left `awaiting_input`/`running` when the device was
 * revoked or the daemon restarted and no longer holds it). Session ids only — cleartext routing metadata,
 * never a session payload (E2E-safe).
 */
export const sessionReconcilePayloadSchema = z.object({
  heldSessionIds: z.array(z.string().min(1)),
});
export type SessionReconcilePayload = z.infer<typeof sessionReconcilePayloadSchema>;

/**
 * A daemon-stamped entry creation time, epoch milliseconds (Phase 3 threads & lineage). Carried on every
 * entry-producing message and on backfilled history entries so segment/entry times stay honest across
 * reloads (a client receive-time lies after a reconnect). Optional for wire compatibility: an old daemon
 * stamps nothing and the UI falls back to client receive-time; an old client's zod strips the field.
 */
export const entryTimestampSchema = z.number().int().nonnegative();
export type EntryTimestamp = z.infer<typeof entryTimestampSchema>;

/** Payload for `agent.message` (daemon → web): a chunk of streamed agent text. */
export const agentMessagePayloadSchema = z.object({
  text: z.string(),
  ts: entryTimestampSchema.optional(),
});
export type AgentMessagePayload = z.infer<typeof agentMessagePayloadSchema>;

/**
 * Payload for `agent.notice` (daemon → web, Journey 3): a non-blocking attention signal for an adopted
 * session, carrying Claude Code's own `Notification` text (e.g. "Claude is waiting for your input" when a
 * session goes idle). Unlike `agent.permission_request` / `agent.question` it requires no answer — it just
 * tells the dashboard the session needs a look. Transient (not cached for reopen).
 */
export const agentNoticePayloadSchema = z.object({ message: z.string().min(1).max(2000) });
export type AgentNoticePayload = z.infer<typeof agentNoticePayloadSchema>;

/** Payload for `agent.tool_use` (daemon → web): a tool the agent ran (informational stream). */
export const agentToolUsePayloadSchema = z.object({
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
  ts: entryTimestampSchema.optional(),
});
export type AgentToolUsePayload = z.infer<typeof agentToolUsePayloadSchema>;

/**
 * The terminal states a `session.ended` can carry (ux Phase 6 status split, B5): `done` = Completed,
 * `error` = Failed, `turn_limit` = the run exhausted its turn budget (daemon-reported; followable),
 * `needs_restart` = the daemon lost the conversation (relay-synthesized on reconcile-retire).
 */
export const SESSION_END_STATUSES = ['done', 'error', 'turn_limit', 'needs_restart'] as const;

/** Payload for `session.ended` (daemon → web): terminal result of the run. */
export const sessionEndedPayloadSchema = z.object({
  status: z.enum(SESSION_END_STATUSES),
  error: z.string().optional(),
});
export type SessionEndedPayload = z.infer<typeof sessionEndedPayloadSchema>;

/**
 * Whether a status is one of the ended states — THE shared terminal check, so adding a status to
 * {@link SESSION_END_STATUSES} propagates to every consumer (relay status resolution, the web's
 * terminal guards) instead of leaving hand-maintained unions half-updated.
 */
export function isSessionEndStatus(value: unknown): value is SessionEndedPayload['status'] {
  return typeof value === 'string' && (SESSION_END_STATUSES as readonly string[]).includes(value);
}

/**
 * Decrypted payload for `session.key` (daemon → web, E2E): the per-session symmetric content key, base64.
 * On the wire this object is itself box-sealed to the browser's ephemeral public key (the bootstrap
 * exception), so only that browser can open it; once unwrapped, every other session payload is encrypted
 * with this key. The relay never sees it — it forwards the sealed envelope verbatim.
 */
export const sessionKeyPayloadSchema = z.object({ key: base64KeySchema });
export type SessionKeyPayload = z.infer<typeof sessionKeyPayloadSchema>;

/**
 * Where a session's display title came from, carried inside the sealed metadata so peers can apply
 * precedence without the relay reading anything: a `user` title (typed at launch, or a rename) is
 * never overwritten by a `derived` one (from the first prompt / the working directory).
 */
export const TITLE_SOURCES = ['derived', 'user'] as const;
export const titleSourceSchema = z.enum(TITLE_SOURCES);
export type TitleSourceName = z.infer<typeof titleSourceSchema>;

/**
 * Payload for `session.meta` (daemon → relay → web, ux Phase 6): the session's identity metadata,
 * sealed under the per-session content key. The daemon emits it on launch/adoption and whenever a
 * field changes (e.g. the model is learned, the title is refined); the relay stores the opaque blob
 * (`sealed_meta` + nonce) so a cold page load can decrypt titles client-side, and replays the latest
 * frame on subscribe. Every field optional: a frame updates what it carries. Bounds mirror the
 * adopted-announce hints so a buggy peer can't bloat the encrypted frame or the registry row.
 */
export const sessionMetaPayloadSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  titleSource: titleSourceSchema.optional(),
  cwd: z.string().min(1).max(1024).optional(),
  /**
   * The repo identity the session runs against — `owner/name` for a cloned GitHub repo, a local
   * checkout's directory name otherwise. Carried separately from `cwd` because a worktree cwd ends
   * in the session id, not the repo (the card's repo tag would otherwise show a UUID). Additive
   * optional: old peers simply never see it.
   */
  repo: z.string().min(1).max(512).optional(),
  /**
   * The git branch the session's workspace is on — the worktree branch for a launched session, the
   * cwd's current branch for an adopted one (live-refreshed). Workspace content: sealed-only, like
   * everything here. Additive optional: old peers simply never see it.
   */
  branch: z.string().min(1).max(MAX_BRANCH_NAME_CHARS).optional(),
  model: z.string().min(1).max(128).optional(),
  permissionMode: permissionModeSchema.optional(),
  ts: entryTimestampSchema.optional(),
});
export type SessionMetaPayload = z.infer<typeof sessionMetaPayloadSchema>;

/** The most files one `session.changes` frame carries — the daemon clips the list and flags
 * `truncated` (totals stay accurate over the FULL diff), so one pathological diff can't bloat the
 * sealed frame. Shared so the daemon's clip and the wire bound can never drift. */
export const MAX_CHANGED_FILES = 200;

/** The longest repo-relative file path one changed-file row carries. */
export const MAX_CHANGED_FILE_PATH_CHARS = 512;

/**
 * One changed file in a `session.changes` summary. `additions`/`deletions` are `null` when a line
 * count is unknowable — a binary file (git numstat `-`) or an untracked file git hasn't diffed —
 * so the UI can render an honest "—" instead of a fake 0.
 */
export const changedFileSchema = z.object({
  path: z.string().min(1).max(MAX_CHANGED_FILE_PATH_CHARS),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

/**
 * Payload for `session.changes` (daemon → relay → web, branch-workflow Phase C): the launched
 * session's diff vs the base branch it was cut from — working tree included, so uncommitted agent
 * work shows up. Sealed under the per-session content key like {@link sessionMetaPayloadSchema};
 * file paths are workspace content the relay must never see. `baseBranch` is the RESOLVED base ref
 * the worktree was actually cut from (e.g. `origin/main`), so the panel can label "vs <base>"
 * truthfully.
 */
export const sessionChangesPayloadSchema = z.object({
  baseBranch: z.string().min(1).max(MAX_BRANCH_NAME_CHARS),
  files: z.array(changedFileSchema).max(MAX_CHANGED_FILES),
  /** Totals over the FULL diff — accurate even when `files` is clipped to {@link MAX_CHANGED_FILES}. */
  totalAdditions: z.number().int().nonnegative(),
  totalDeletions: z.number().int().nonnegative(),
  truncated: z.boolean(),
  ts: entryTimestampSchema.optional(),
});
export type SessionChangesPayload = z.infer<typeof sessionChangesPayloadSchema>;

/**
 * Payload for `session.title` (relay → web, ux Phase 6 T6): the user's rename override, kept in a blob
 * SEPARATE from `session.meta` (the daemon-owned identity) so the two never race — the browser merges
 * override-wins, and a later derived `session.meta` can never clobber a rename. The relay broadcasts this
 * frame after a `PATCH /me/sessions/:id`. A SET is sealed (this `{ title }` shape is what the ciphertext
 * decrypts to, so the relay never reads it); a RESET-to-derived is the cleartext `{ reset: true }` marker
 * (it carries no secret). The `title` bound mirrors {@link sessionMetaPayloadSchema}'s.
 */
export const sessionTitlePayloadSchema = z.union([
  z.object({ title: z.string().min(1).max(512) }),
  z.object({ reset: z.literal(true) }),
]);
export type SessionTitlePayload = z.infer<typeof sessionTitlePayloadSchema>;

/**
 * The single ceiling for every OPAQUE sealed blob the relay stores but can never read (`sealed_meta`,
 * `sealed_title`, …). The plaintext schemas cap their fields (title 512, cwd 1024, model 128 chars), so
 * even with AES-GCM + base64 overhead a legitimate blob is well under 8 KiB; the nonce is a 12-byte GCM IV
 * (16 base64 chars). ONE source of truth so the relay's route zod, the relay's DB CHECK (migrations
 * 0008/0009), and the web's BFF re-validation can never drift.
 */
export const MAX_SEALED_BLOB_CHARS = 8192;
export const MAX_SEALED_BLOB_NONCE_CHARS = 64;

/**
 * The `PATCH /me/sessions/:id` rename body (ux Phase 6 T6): a SET carries the browser-sealed title blob +
 * nonce; a RESET-to-derived is `{ sealed_title: null }`. Shared by the relay route and the web BFF (each
 * re-validates at its own trust boundary) so the snake_case wire shape + bounds live in one place. The
 * title itself is ciphertext neither the relay nor the web server ever reads (invariant #5).
 */
export const sessionRenameBodySchema = z.union([
  z.object({
    sealed_title: z.string().min(1).max(MAX_SEALED_BLOB_CHARS),
    sealed_title_nonce: z.string().min(1).max(MAX_SEALED_BLOB_NONCE_CHARS),
  }),
  z.object({ sealed_title: z.null() }),
]);
export type SessionRenameBody = z.infer<typeof sessionRenameBodySchema>;

/**
 * A rough ±lines summary for a file-writing tool request (mockup §01-4), computed daemon-side at gate
 * time so a routine call is decidable straight from the inbox card. Optional everywhere: absent for
 * tools it doesn't apply to, for pre-diff-stat daemons, and whenever the daemon couldn't compute one.
 */
export const diffStatSchema = z.object({
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
});
export type DiffStat = z.infer<typeof diffStatSchema>;

/**
 * Payload for `agent.permission_request` (daemon → web): a consequential tool call the agent wants to
 * run, paused at the {@link https://docs.claude.com SDK `canUseTool` gate} until a human decides. The
 * `requestId` correlates this request with the human's {@link permissionDecisionPayloadSchema} reply.
 */
export const agentPermissionRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
  diffStat: diffStatSchema.optional(),
  ts: entryTimestampSchema.optional(),
});
export type AgentPermissionRequestPayload = z.infer<typeof agentPermissionRequestPayloadSchema>;

/**
 * Payload for `permission.decision` (web → daemon): the human's verdict on a pending tool request,
 * discriminated on `behavior`. `allow` may carry `updatedInput` (allow-with-edit — replaces the agent's
 * proposed input); `deny` may carry a `message` surfaced back to the agent. The `requestId` ties the
 * decision to its originating {@link agentPermissionRequestPayloadSchema}.
 */
export const permissionDecisionPayloadSchema = z.discriminatedUnion('behavior', [
  z.object({
    requestId: z.string().min(1),
    behavior: z.literal('allow'),
    updatedInput: z.record(z.unknown()).optional(),
  }),
  z.object({
    requestId: z.string().min(1),
    behavior: z.literal('deny'),
    message: z.string().optional(),
  }),
]);
export type PermissionDecisionPayload = z.infer<typeof permissionDecisionPayloadSchema>;

/**
 * One option of an adopted-session question, mirroring a Claude Code `AskUserQuestion` option. `description`
 * is optional for resilience against tool-schema drift across Claude Code versions (the UI tolerates its
 * absence); bounded so a buggy/old version can't bloat the encrypted frame.
 */
export const agentQuestionOptionSchema = z.object({
  label: z.string().min(1).max(256),
  description: z.string().max(2000).optional(),
});
export type AgentQuestionOption = z.infer<typeof agentQuestionOptionSchema>;

/** One question of an adopted-session `AskUserQuestion`, with its options and single/multi-select mode. */
export const agentQuestionItemSchema = z.object({
  question: z.string().min(1).max(4000),
  header: z.string().min(1).max(120),
  multiSelect: z.boolean(),
  options: z.array(agentQuestionOptionSchema).min(1).max(20),
});
export type AgentQuestionItem = z.infer<typeof agentQuestionItemSchema>;

/**
 * Payload for `agent.question` (daemon → web, Journey 2 / Phase 3): an adopted Claude Code session raised
 * the built-in `AskUserQuestion` tool, intercepted at the `PreToolUse` hook. It mirrors the tool's input so
 * the phone can render the picker; the human's reply ({@link questionAnswerPayloadSchema}) is relayed back
 * to the model as *deny-feedback* (a best-effort answer — the only channel an externally-driven session
 * exposes). The `requestId` correlates the question with its answer (the same gate pattern as
 * {@link agentPermissionRequestPayloadSchema}). "Other" is always implicitly available — Claude Code sends
 * no `allowsOther` flag — so the UI always offers a free-text field and it is carried only on the answer.
 */
export const agentQuestionPayloadSchema = z.object({
  requestId: z.string().min(1),
  questions: z.array(agentQuestionItemSchema).min(1).max(10),
  ts: entryTimestampSchema.optional(),
});
export type AgentQuestionPayload = z.infer<typeof agentQuestionPayloadSchema>;

/**
 * One answer to a question, positionally matching the question at the same index. A pick is some chosen
 * option `selectedLabels` (one for single-select, several for multi-select) and/or free-text `otherText`
 * (the always-available "Other"). At least one must be present — an empty answer is meaningless.
 */
export const questionAnswerItemSchema = z
  .object({
    selectedLabels: z.array(z.string().min(1).max(256)).max(20).default([]),
    otherText: z.string().min(1).max(4000).optional(),
  })
  .refine((a) => a.selectedLabels.length > 0 || a.otherText !== undefined, {
    message: 'each answer must carry at least one selected label or otherText',
  });
export type QuestionAnswerItem = z.infer<typeof questionAnswerItemSchema>;

/**
 * Payload for `question.answer` (web → daemon, Journey 2 / Phase 3): the human's reply to a pending
 * {@link agentQuestionPayloadSchema}, one entry per question (same order). The daemon frames these as a
 * relayed user answer and returns it to the model via the `PreToolUse` deny-feedback channel. `requestId`
 * ties the answer to its question.
 */
export const questionAnswerPayloadSchema = z.object({
  requestId: z.string().min(1),
  answers: z.array(questionAnswerItemSchema).min(1).max(10),
});
export type QuestionAnswerPayload = z.infer<typeof questionAnswerPayloadSchema>;

/**
 * Payload for `agent.handover` (daemon → web, Journey 4 / Tier 4): an adopted session ended its turn asking
 * a **free-form** question — prose, no tool call — so there is no `PreToolUse` gate to answer through.
 * Rather than a dead "answer at your device" wall, telecode offers to take the conversation over: this
 * message is a NON-blocking offer carrying the exact `question` (Claude Code's `Stop` hook
 * `last_assistant_message`) and a deterministic `summary` of recent context. The human's reply
 * ({@link handoverAnswerPayloadSchema}) launches a telecode-owned continuation that **resumes** the same
 * conversation. `requestId` correlates the offer with its answer. `summary` may be empty (little context).
 * Bounds keep a long transcript from bloating the encrypted frame.
 */
export const agentHandoverPayloadSchema = z.object({
  requestId: z.string().min(1),
  question: z.string().min(1).max(8000),
  summary: z.string().max(8000),
  ts: entryTimestampSchema.optional(),
});
export type AgentHandoverPayload = z.infer<typeof agentHandoverPayloadSchema>;

/**
 * Payload for `handover.answer` (web → daemon, Journey 4): the human's free-text answer to a pending
 * {@link agentHandoverPayloadSchema}. It triggers the daemon to launch a forked, telecode-owned session
 * that resumes the adopted conversation (`resume` + `forkSession`) with `answerText` as the next turn.
 * Unlike `question.answer` this is an **action trigger**, not deny-feedback. `requestId` ties it to the offer.
 */
export const handoverAnswerPayloadSchema = z.object({
  requestId: z.string().min(1),
  answerText: z.string().min(1).max(8000),
});
export type HandoverAnswerPayload = z.infer<typeof handoverAnswerPayloadSchema>;

/**
 * Payload for `session.chained` (daemon → relay → browser, Journey 4): the daemon registers the forked
 * continuation that resumes an adopted conversation, so the relay mints a registry row (`origin: 'launched'`)
 * linked to the adopted parent via `parentSessionId`. Symmetric with {@link sessionAdoptedPayloadSchema} —
 * `clientRef` is the daemon's correlation token, echoed back with the minted telecode `session_id` — but the
 * child is a telecode-owned launched session, and `parentSessionId` records the adopted → launched migration.
 */
export const sessionChainedPayloadSchema = z.object({
  clientRef: z.string().min(1).max(256),
  // A relay-minted telecode session id (the adopted parent) — validated as a UUID at the boundary so a
  // malformed value is rejected on parse rather than failing later against the `uuid` DB column.
  parentSessionId: z.string().uuid(),
  title: z.string().min(1).max(512).optional(),
  cwd: z.string().min(1).max(1024).optional(),
});
export type SessionChainedPayload = z.infer<typeof sessionChainedPayloadSchema>;

/**
 * Payload for `user.message` (web → daemon): a follow-up instruction the human sends to steer an
 * already-launched session. The daemon resumes the same agent conversation for the next turn (the
 * session id is on the envelope).
 */
export const userMessagePayloadSchema = z.object({ text: z.string().min(1) });
export type UserMessagePayload = z.infer<typeof userMessagePayloadSchema>;

/**
 * Payload for `session.control` (web → daemon): an operator control for a session. `interrupt` aborts the
 * in-flight turn (like pressing Esc) — the session stays followable, so the human just sends another
 * message to continue; `end` terminates the session (no more turns). The session id is on the envelope.
 */
export const sessionControlActionSchema = z.enum(['end', 'interrupt']);
export type SessionControlAction = z.infer<typeof sessionControlActionSchema>;
export const sessionControlPayloadSchema = z.object({ action: sessionControlActionSchema });
export type SessionControlPayload = z.infer<typeof sessionControlPayloadSchema>;

/**
 * Payload for `session.subscribe` (web → daemon): re-attach to an existing session on UI reopen/reload.
 * The session id is on the envelope; the daemon replies with {@link sessionHistoryPayloadSchema}.
 */
export const sessionSubscribePayloadSchema = z.object({});
export type SessionSubscribePayload = z.infer<typeof sessionSubscribePayloadSchema>;

/**
 * One entry of a backfilled transcript (in `session.history`), mirroring the UI's transcript kinds. A
 * `permission` carries its resolved verdict so the replay shows a decided gate without action buttons
 * (`pending` still awaits a human); `allow`/`deny` render as approved/rejected.
 */
export const sessionHistoryEntrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), text: z.string(), ts: entryTimestampSchema.optional() }),
  z.object({ kind: z.literal('message'), text: z.string(), ts: entryTimestampSchema.optional() }),
  z.object({
    kind: z.literal('tool'),
    toolName: z.string().min(1),
    input: z.record(z.unknown()),
    ts: entryTimestampSchema.optional(),
  }),
  z.object({
    kind: z.literal('permission'),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.record(z.unknown()),
    diffStat: diffStatSchema.optional(),
    decision: z.enum(['pending', 'allow', 'deny']),
    ts: entryTimestampSchema.optional(),
  }),
  // An adopted-session multiple-choice question (Journey 2). Carries the question(s) so a replay can render
  // the picker; `answers` is present once the human has answered (one per question) and absent while pending
  // — the same decided-vs-pending distinction as a `permission` entry, so backfill shows it correctly.
  z.object({
    kind: z.literal('question'),
    requestId: z.string().min(1),
    questions: z.array(agentQuestionItemSchema).min(1),
    answers: z.array(questionAnswerItemSchema).optional(),
    ts: entryTimestampSchema.optional(),
  }),
  // A free-form handover offer (Journey 4). Carries the exact question + summary so a replay can render the
  // "continue here" card; `answerText` is present once the human took it over (resolved) and absent while
  // the offer is still open — the same decided-vs-pending distinction as `permission` / `question` entries.
  z.object({
    kind: z.literal('handover'),
    requestId: z.string().min(1),
    question: z.string().min(1),
    summary: z.string(),
    answerText: z.string().min(1).optional(),
    ts: entryTimestampSchema.optional(),
  }),
]);
export type SessionHistoryEntry = z.infer<typeof sessionHistoryEntrySchema>;

/**
 * Payload for `session.history` (daemon → web): the ordered transcript + current status, sent in
 * response to `session.subscribe`. Backfill comes from the daemon — the live transcript holder — so the
 * relay never needs the plaintext (consistent with E2E in Phase 3). Reopen is a reconnect, not a restart.
 */
export const sessionHistoryPayloadSchema = z.object({
  status: sessionStatusSchema,
  entries: z.array(sessionHistoryEntrySchema),
});
export type SessionHistoryPayload = z.infer<typeof sessionHistoryPayloadSchema>;
