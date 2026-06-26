import { z } from 'zod';

import { base64KeySchema, sessionStatusSchema, type SessionStatusName } from './session';

/**
 * Wire protocol version. Bump on any breaking change to the envelope or message union.
 * All three peers (web, relay, daemon) MUST agree on this.
 */
export const PROTOCOL_VERSION = 1 as const;

/**
 * Every message type that can cross the wire. The relay routes by `(user_id, device_id)`
 * and never needs to understand the payload — only `type` for a few control messages.
 *
 * `echo` / `echo.reply` are the Phase 0 walking-skeleton round-trip; the rest are the
 * core product messages from the development plan (§7.2).
 */
export const MESSAGE_TYPES = [
  // control / lifecycle (daemon <-> relay)
  'hello',
  'hello.ack',
  // Phase 0 walking skeleton (web <-> daemon, via relay)
  'echo',
  'echo.reply',
  // session lifecycle (web <-> daemon)
  'session.launch',
  'session.started',
  'session.ended',
  // agent stream (daemon -> web)
  'agent.message',
  'agent.tool_use',
  'agent.permission_request',
  // human-in-the-loop + follow-ups (web -> daemon)
  'permission.decision',
  'user.message',
  // per-session controls (web -> daemon): end / interrupt / pause / resume
  'session.control',
  // reconnect (web <-> daemon)
  'session.subscribe',
  'session.history',
  // E2E key delivery (daemon -> web): the per-session content key, box-sealed to the browser's pubkey
  'session.key',
  // device presence (relay -> web): the daemon behind the channel (dis)connected, so the browser can
  // flip its live sessions to `offline_paused` and resume them on reconnect. Cleartext routing metadata
  // the relay generates itself — it carries no session payload.
  'device.presence',
] as const;

export const messageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof messageTypeSchema>;

/**
 * The single envelope shared by every peer. Wire fields are snake_case to match the
 * protocol contract in the plan; `payload` is a JSON body in plaintext mode (Phase 0)
 * and ciphertext once E2E lands (Phase 3). `nonce` is the base64 crypto_box nonce, or
 * an empty string when the payload is not encrypted.
 *
 * `status` and `sender_public_key` are E2E **routing metadata** — small, non-secret fields the relay
 * reads without ever decrypting the payload (plan §3.5 honest-metadata caveat):
 *  - `status` lets the relay update the Postgres session registry from a lifecycle message whose payload
 *    is now ciphertext. It reveals only that a session exists and its coarse state.
 *  - `sender_public_key` carries a browser's ephemeral X25519 public key (base64) on `session.launch`/
 *    `session.subscribe` so the daemon can wrap the per-session content key to it. A public key is not
 *    secret; the relay brokering it is the plan's documented key-exchange model.
 */
export const envelopeSchema = z.object({
  v: z.literal(PROTOCOL_VERSION),
  user_id: z.string().min(1),
  device_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  type: messageTypeSchema,
  nonce: z.string(),
  status: sessionStatusSchema.optional(),
  sender_public_key: base64KeySchema.optional(),
  payload: z.unknown(),
});

export type Envelope = z.infer<typeof envelopeSchema>;

/** Payload for `echo` / `echo.reply` — the walking-skeleton round-trip. */
export const echoPayloadSchema = z.object({ text: z.string() });
export type EchoPayload = z.infer<typeof echoPayloadSchema>;

/** The two peer roles that dial out to the relay. */
export const peerRoleSchema = z.enum(['daemon', 'browser']);
export type PeerRole = z.infer<typeof peerRoleSchema>;

/**
 * Payload for `hello` — a peer announcing its role when it connects to the relay. `token` carries the
 * caller's credential: a short-lived channel token for a `browser`, and (from Phase 1 pairing) a device
 * token for a `daemon`. Optional so the Phase 0 echo path still connects without auth.
 */
export const helloPayloadSchema = z.object({
  role: peerRoleSchema,
  token: z.string().min(1).optional(),
});
export type HelloPayload = z.infer<typeof helloPayloadSchema>;

/** Validate an inbound value as an Envelope, throwing `ZodError` on mismatch. */
export function parseEnvelope(raw: unknown): Envelope {
  return envelopeSchema.parse(raw);
}

/** Non-throwing variant — returns a discriminated `{ success }` result. */
export function safeParseEnvelope(raw: unknown): z.SafeParseReturnType<unknown, Envelope> {
  return envelopeSchema.safeParse(raw);
}

/** Construct a validated envelope. Throws if the inputs don't form a valid envelope. */
export function makeEnvelope(params: {
  type: MessageType;
  userId: string;
  deviceId: string;
  payload: unknown;
  sessionId?: string;
  nonce?: string;
  /** Cleartext lifecycle status (routing metadata) — set on lifecycle messages under E2E. */
  status?: SessionStatusName;
  /** Sender's ephemeral X25519 public key (base64) — set by a browser on launch/subscribe. */
  senderPublicKey?: string;
}): Envelope {
  return envelopeSchema.parse({
    v: PROTOCOL_VERSION,
    user_id: params.userId,
    device_id: params.deviceId,
    ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}),
    type: params.type,
    nonce: params.nonce ?? '',
    ...(params.status !== undefined ? { status: params.status } : {}),
    ...(params.senderPublicKey !== undefined ? { sender_public_key: params.senderPublicKey } : {}),
    payload: params.payload,
  });
}
