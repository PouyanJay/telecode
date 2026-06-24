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
