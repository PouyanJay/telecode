import { z } from 'zod';

/**
 * Payload schemas for the session lifecycle messages (web ⇄ daemon, via the relay). These define the
 * plaintext shape carried in `Envelope.payload`; in E2E mode (Phase 3) the same shape is encrypted, so
 * the relay never reads them — it routes on envelope metadata alone. Tightly-coupled sibling schemas
 * live together here by design.
 */

/** The Agent SDK permission modes, surfaced on the wire. Default is the conservative `default`. */
export const permissionModeSchema = z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']);
export type PermissionModeName = z.infer<typeof permissionModeSchema>;

/** Payload for `session.launch` (web → daemon): parameters to start one new agent session. */
export const sessionLaunchPayloadSchema = z.object({
  prompt: z.string().min(1),
  /** Working directory for the session (single cwd in Phase 1; git worktrees in Phase 2). */
  cwd: z.string().min(1).optional(),
  permissionMode: permissionModeSchema.optional(),
  /** Optional user-facing label. */
  title: z.string().min(1).optional(),
});
export type SessionLaunchPayload = z.infer<typeof sessionLaunchPayloadSchema>;

/** Payload for `session.started` (daemon → web): the session is now running. The id is on the envelope. */
export const sessionStartedPayloadSchema = z.object({});
export type SessionStartedPayload = z.infer<typeof sessionStartedPayloadSchema>;

/** Session lifecycle states; mirrors the `sessions.status` column. */
export const SESSION_STATUSES = [
  'starting',
  'running',
  'awaiting_input',
  'done',
  'error',
  'offline_paused',
] as const;
export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatusName = z.infer<typeof sessionStatusSchema>;

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

/** Payload for `session.status` (daemon → web): a status transition. */
export const sessionStatusPayloadSchema = z.object({ status: sessionStatusSchema });
export type SessionStatusPayload = z.infer<typeof sessionStatusPayloadSchema>;

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
