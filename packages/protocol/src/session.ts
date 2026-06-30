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
const repoPathSegmentSchema = z
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

/** Payload for `session.launch` (web → daemon): parameters to start one new agent session. */
export const sessionLaunchPayloadSchema = z.object({
  prompt: z.string().min(1),
  /** GitHub repo to clone-on-demand and run in; omitted runs in the daemon's configured/default cwd. */
  repo: sessionRepoSchema.optional(),
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

/** Session lifecycle states; mirrors the `sessions.status` column. */
export const SESSION_STATUSES = [
  'starting',
  'running',
  'awaiting_input',
  'done',
  'error',
  // The device is off, so the session can't run; it resumes when the daemon reconnects.
  'offline_paused',
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

/** Payload for `agent.message` (daemon → web): a chunk of streamed agent text. */
export const agentMessagePayloadSchema = z.object({ text: z.string() });
export type AgentMessagePayload = z.infer<typeof agentMessagePayloadSchema>;

/** Payload for `agent.tool_use` (daemon → web): a tool the agent ran (informational stream). */
export const agentToolUsePayloadSchema = z.object({
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
});
export type AgentToolUsePayload = z.infer<typeof agentToolUsePayloadSchema>;

/** Payload for `session.ended` (daemon → web): terminal result of the run. */
export const sessionEndedPayloadSchema = z.object({
  status: z.enum(['done', 'error']),
  error: z.string().optional(),
});
export type SessionEndedPayload = z.infer<typeof sessionEndedPayloadSchema>;

/**
 * Decrypted payload for `session.key` (daemon → web, E2E): the per-session symmetric content key, base64.
 * On the wire this object is itself box-sealed to the browser's ephemeral public key (the bootstrap
 * exception), so only that browser can open it; once unwrapped, every other session payload is encrypted
 * with this key. The relay never sees it — it forwards the sealed envelope verbatim.
 */
export const sessionKeyPayloadSchema = z.object({ key: base64KeySchema });
export type SessionKeyPayload = z.infer<typeof sessionKeyPayloadSchema>;

/**
 * Payload for `agent.permission_request` (daemon → web): a consequential tool call the agent wants to
 * run, paused at the {@link https://docs.claude.com SDK `canUseTool` gate} until a human decides. The
 * `requestId` correlates this request with the human's {@link permissionDecisionPayloadSchema} reply.
 */
export const agentPermissionRequestPayloadSchema = z.object({
  requestId: z.string().min(1),
  toolName: z.string().min(1),
  input: z.record(z.unknown()),
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
  z.object({ kind: z.literal('user'), text: z.string() }),
  z.object({ kind: z.literal('message'), text: z.string() }),
  z.object({
    kind: z.literal('tool'),
    toolName: z.string().min(1),
    input: z.record(z.unknown()),
  }),
  z.object({
    kind: z.literal('permission'),
    requestId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.record(z.unknown()),
    decision: z.enum(['pending', 'allow', 'deny']),
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
