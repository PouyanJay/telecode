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
  // adopted sessions (daemon -> relay -> web): the daemon announces an externally-started Claude Code
  // session it discovered via the hooks bridge, so the relay mints a registry row (origin='external').
  'session.adopted',
  // free-form handover (daemon -> relay -> web): the daemon registers a telecode-OWNED continuation that
  // resumes an adopted conversation the user chose to take over remotely (origin='launched'), linked to the
  // adopted row via `parent_session_id`. Symmetric with `session.adopted`, but the child is launched. (J4.)
  'session.chained',
  // agent stream (daemon -> web)
  'agent.message',
  'agent.tool_use',
  'agent.permission_request',
  // adopted-session questions (daemon -> web): an `AskUserQuestion` raised by an externally-driven Claude
  // Code session, intercepted at the PreToolUse hook so the phone can answer it (best-effort, Journey 2).
  'agent.question',
  // adopted-session attention signal (daemon -> web): Claude Code's `Notification` (e.g. went idle waiting
  // for input) surfaced as a non-blocking "needs a look" cue. No answer required (Journey 3).
  'agent.notice',
  // free-form handover offer (daemon -> web, Journey 4): an adopted session ended its turn asking a
  // free-form question (no tool call, so no gate). Non-blocking — carries the exact question + a handover
  // summary so the browser can offer to take the conversation over by resuming it under telecode's control.
  'agent.handover',
  // adoption policy (Journey 3), session-less + box-sealed so the relay never sees repo paths:
  // `adopt.config` (web -> daemon) reads/sets the per-machine enabled + denylist; `adopt.state`
  // (daemon -> web) reports the current policy back to the requesting browser.
  'adopt.config',
  'adopt.state',
  // local-repo branch listing (branch-launch Phase B), session-less + box-sealed like adopt.*:
  // `repo.branches` (web -> daemon) asks for the DEFAULT repo's branches; `repo.branches.state`
  // (daemon -> web) answers the requesting browser — branch names are content, sealed only.
  'repo.branches',
  'repo.branches.state',
  // Worktree/branch hygiene (branch-actions Phase C), a device-scoped box-sealed RPC like adopt.*:
  // `workspace.reap` (web -> daemon) asks — as the delete flow's explicit opt-in — to remove a
  // launched session's worktree and branch; `workspace.reap.state` (daemon -> web) answers the
  // requesting browser with ok or a coded refusal. The PAYLOAD is sealed (paths/branch names never
  // reach the relay); unlike adopt.*, the ENVELOPE deliberately carries the session id — cleartext
  // routing metadata (as on every session frame) so the relay's offline-honesty path can name the
  // action that went nowhere. The daemon authorizes from the SEALED id only.
  'workspace.reap',
  'workspace.reap.state',
  // Between-turns branch switch for LAUNCHED sessions (branch-actions T4), session-scoped and
  // sealed under the session content key: `session.branch.switch` (web -> daemon) asks to check
  // out an existing branch in the session's worktree; `session.branch.state` (daemon -> web)
  // settles the ask (ok + the branch, or a coded refusal — mid-turn, dirty, …).
  'session.branch.switch',
  'session.branch.state',
  // Open PR, push leg (branch-actions T6), session-scoped and sealed like the switch: the daemon
  // pushes the session branch to origin WITH THE LAPTOP'S OWN GIT CREDENTIALS (the relay's GitHub
  // token never travels, per the plan) and answers `session.push.state` — ok with the pushed
  // branch/base (+ owner/name when origin is a github.com remote, so the BROWSER can open the PR
  // page under the user's own signed-in account), or a coded refusal. No GitHub API call happens
  // anywhere outside the user's browser.
  'session.push',
  'session.push.state',
  // human-in-the-loop + follow-ups (web -> daemon)
  'permission.decision',
  // the human's pick for an `agent.question`, relayed to the model as deny-feedback (web -> daemon).
  'question.answer',
  // the human's answer to an `agent.handover` (web -> daemon, Journey 4): triggers the daemon to launch a
  // forked telecode-owned continuation that resumes the adopted conversation with this answer as its turn.
  'handover.answer',
  'user.message',
  // resume-as-new (web -> daemon, ux Phase 6 T8): continue a TERMINAL session as a NEW linked one —
  // the daemon fork-resumes the conversation when it still can (SDK resume + forkSession) or fresh-
  // launches otherwise, minting the child through the existing `session.chained` machinery. Sealed
  // like `session.launch` (box-sealed to the daemon), NOT under the parent's content key: a
  // needs_restart parent after a restart may have no key anywhere, and this frame must still open.
  'session.resume_new',
  // non-terminal status report (daemon -> relay -> web, adopted-takeover T1): the session's lifecycle
  // moved without any content frame to imply it — e.g. an ADOPTED session's turn ended (`waiting_local`)
  // or a new local turn began (`running`). The status rides the envelope's cleartext `status` routing
  // field (like `session.ended`); the payload carries nothing. The relay updates the registry from it
  // exactly as it does from lifecycle/gate frame types — type-driven, payload-blind.
  'session.status',
  // per-session controls (web -> daemon): end / interrupt / pause / resume
  'session.control',
  // reconnect (web <-> daemon)
  'session.subscribe',
  'session.history',
  // E2E key delivery (daemon -> web): the per-session content key, box-sealed to the browser's pubkey
  'session.key',
  // sealed session metadata (daemon -> relay -> web, ux Phase 6): title/cwd/model/permission-mode,
  // encrypted under the per-session content key. The relay stores the opaque blob for cold loads and
  // forwards/replays it; only browsers holding the session key can read it (invariant #5 — the registry
  // never sees plaintext metadata for a sealed session).
  'session.meta',
  // sealed branch-diff summary (daemon -> relay -> web, branch-workflow Phase C): the launched
  // session's working-tree diff vs its base branch (files, ±N), encrypted under the per-session
  // content key exactly like `session.meta`. The daemon emits it after workspace prep, on subscribe,
  // and between turns; the relay only ever forwards/replays the opaque blob (invariant #5 — file
  // paths and counts are workspace content the relay must never see).
  'session.changes',
  // session rename override (relay -> web, ux Phase 6 T6): the user's title override, broadcast after a
  // `PATCH /me/sessions/:id`. Kept SEPARATE from `session.meta` (the daemon-owned identity) so the two
  // never race — the browser merges override-wins. A SET carries the sealed `{ title }` ciphertext; a
  // RESET-to-derived carries the cleartext `{ reset: true }` marker (no secret). The relay stores the
  // opaque blob in `sealed_title`/`sealed_title_nonce` and never reads a set title (invariant #5).
  'session.title',
  // device presence (relay -> web): the daemon behind the channel (dis)connected, so the browser can
  // flip its live sessions to `offline_paused` and resume them on reconnect. Cleartext routing metadata
  // the relay generates itself — it carries no session payload.
  'device.presence',
  // viewer presence (relay -> daemon): the mirror of `device.presence`. Tells the daemon whether ANY
  // browser is currently connected on its channel, so an adopted session only holds a tool for a remote
  // approval when someone is actually there to give it — otherwise the daemon defers to Claude Code's own
  // local prompt, never freezing a session the user is driving locally. Relay-generated cleartext metadata.
  'viewer.presence',
  // session reconciliation (daemon -> relay): on every (re)connect the daemon reports the sessions it
  // actually still holds, so the relay can retire (mark ended) any other non-terminal session for that
  // device left stale in the registry — e.g. a session that was `awaiting_input` when the device was
  // revoked or the daemon restarted. Cleartext routing metadata (session ids only), no session payload.
  'session.reconcile',
  // delivery failure (relay -> web): a browser frame could not reach its daemon (e.g. the device is
  // offline), so the sender must not pretend it was acted on — an approval that went nowhere shows as
  // undelivered, never as a spinner. Relay-generated cleartext routing metadata: an error code + the
  // type of the frame that failed; never any session payload.
  'relay.error',
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
