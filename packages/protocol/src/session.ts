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
