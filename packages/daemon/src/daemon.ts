import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';

import { pino, type Logger } from 'pino';
import WebSocket from 'ws';

import {
  adoptConfigPayloadSchema,
  echoPayloadSchema,
  handoverAnswerPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  questionAnswerPayloadSchema,
  sessionAdoptedPayloadSchema,
  sessionChainedPayloadSchema,
  sessionControlPayloadSchema,
  sessionEndedPayloadSchema,
  sessionLaunchPayloadSchema,
  sessionSubscribePayloadSchema,
  userMessagePayloadSchema,
  viewerPresencePayloadSchema,
  WS_CLOSE_UNAUTHORIZED,
  type AdoptSettings,
  type AdoptStatePayload,
  type AgentQuestionItem,
  type Envelope,
  type MessageType,
  type PermissionDecisionPayload,
  type PermissionModeName,
  type QuestionAnswerItem,
  type SessionControlAction,
  type SessionHistoryEntry,
  type SessionHistoryPayload,
  type SessionLaunchPayload,
  type SessionStatusName,
} from '@telecode/protocol';

import { DEFAULT_ADOPT_SETTINGS, loadAdoptConfig, saveAdoptConfig } from './adopt/adopt-config';
import { DaemonUnauthorizedError } from './daemon-unauthorized-error';
import { createAdoptedSessionManager, type AdoptedSessionManager } from './adopt/adopted-sessions';
import { adoptedGateDecision } from './adopt/adopted-gate-decision';
import { type HookEvent } from './adopt/hook-event';
import { buildHandoverFallbackPrompt } from './adopt/handover-fallback-prompt';
import { buildHandoverSummary } from './adopt/handover-summary';
import { installHooks } from './adopt/hooks-install';
import { readHooksStatus } from './adopt/hooks-status';
import { uninstallHooks } from './adopt/hooks-uninstall';
import { isAdoptionAllowed } from './adopt/is-adoption-allowed';
import { isFreeFormQuestion } from './adopt/free-form-question';
import { createHookSocketServer, type HookSocketServer } from './adopt/hook-socket';
import { preToolUseOutput } from './adopt/pretooluse-output';
import { buildQuestionDenyReason } from './adopt/question-deny-reason';
import { questionsFromToolInput } from './adopt/question-from-tool-input';
import { createTranscriptMirror, type TranscriptMirror } from './adopt/transcript-mirror';
import {
  type AgentAdapter,
  type AgentRunOptions,
  type AgentRunResult,
  type PermissionDecision,
  type PermissionRequest,
} from './agent-adapter';
import { createClaudeAgentAdapter } from './claude-agent-adapter';
import { classifyTool } from './permission-policy';
import { createSessionCipher } from './session-cipher';
import { type RepoManager } from './sessions/repo-manager';
import { type SessionStore } from './sessions/session-store';
import { type WorktreeManager } from './sessions/worktree-manager';

/** How much of a free-form question to preview in a handover continuation's title (UI readability budget). */
const HANDOVER_TITLE_PREVIEW_CHARS = 60;

/**
 * The local daemon: it dials *out* to the relay (laptops sit behind NAT — nothing ever
 * reaches in), announces itself for `(userId, deviceId)`, and supervises work for that
 * device. On `session.launch` it runs an {@link AgentAdapter} turn and streams `agent.message`
 * / `agent.tool_use` up, then `session.ended`; a `user.message` follow-up resumes the same agent
 * conversation for another turn. Every consequential tool the agent wants to run is routed through the
 * human-in-the-loop gate: the daemon forwards it as `agent.permission_request` and blocks `canUseTool`
 * until the matching `permission.decision` returns from the browser.
 */
export interface DaemonOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  /** Device token presented on `hello`; the relay verifies it when device auth is configured. */
  readonly deviceToken?: string;
  /**
   * This device's X25519 keypair (base64), persisted at pairing. When provided, the daemon runs sessions
   * end-to-end encrypted (Phase 3): it decrypts the sealed launch, mints a per-session content key,
   * delivers it to the browser, and encrypts the stream. Omitted runs sessions in cleartext (pre-E2E).
   */
  readonly keyPair?: { readonly publicKey: string; readonly privateKey: string };
  /** Agent runtime. Defaults to the real Claude Agent SDK adapter; tests inject a fake. */
  readonly agentAdapter?: AgentAdapter;
  /**
   * Cuts a git worktree per session (Phase 2). When provided, a session that resolves a repo runs in its
   * own worktree cwd so parallel agents never clobber each other's files. Omitted falls back to the
   * daemon's own cwd — the Phase-1 behavior.
   */
  readonly worktreeManager?: WorktreeManager;
  /** Clones the repo a launch selects, on demand (Task 8). Required for `session.launch` to carry a repo. */
  readonly repoManager?: RepoManager;
  /**
   * A local repo to use when a launch carries no `repo` (e.g. `TELECODE_REPO`). Lets sessions run in a
   * worktree off a fixed local checkout without GitHub; omitted means a repo-less launch runs in the
   * daemon cwd.
   */
  readonly defaultRepoPath?: string;
  /**
   * Durable on-disk store for finished session transcripts (architecture invariant #7). When provided, the
   * daemon loads persisted sessions on start and writes a session's transcript when it reaches a terminal
   * state, so a reopened-but-finished session survives a daemon restart instead of backfilling empty.
   * Omitted (e.g. in tests) keeps sessions in memory only.
   */
  readonly sessionStore?: SessionStore;
  /**
   * Reconnect backoff bounds (Phase 4). The daemon dials *out* to the relay; if that link drops it
   * redials with exponential backoff + jitter between `baseMs` and `maxMs`. Defaults to 500ms → 10s;
   * tests inject small values for speed.
   */
  readonly reconnect?: { readonly baseMs?: number; readonly maxMs?: number };
  /**
   * Invoked when the relay rejects the device token as unauthorized (close 4001) on a *reconnect* — i.e.
   * the device was revoked while the daemon was running. The daemon stops redialing the dead token; the
   * composition root re-pairs. (On the *first* connect, `start()` rejects with {@link DaemonUnauthorizedError}
   * instead, so the caller can react before the daemon is considered up.)
   */
  readonly onUnauthorized?: () => void;
  /**
   * Adopt externally-started Claude Code sessions (opt-in). When set, the daemon listens on a local Unix
   * socket for the `telecode hook` bridge: it announces each discovered session to the relay
   * (`origin='external'`), mirrors its transcript from the hook-provided `transcript_path`, and routes its
   * consequential tool calls through telecode's existing approval gate. Omitted (default) → no adoption.
   */
  readonly adopt?: {
    readonly socketPath: string;
    readonly ackTimeoutMs?: number;
    /**
     * Path to the per-machine adoption policy (`~/.telecode/adopt-config.json`). Loaded on start and
     * rewritten when the web sets it (sealed `adopt.config`). Omitted → the adopt-all default, held in
     * memory only (a web change applies for the session but isn't persisted).
     */
    readonly configPath?: string;
    /**
     * Frictionless setup: when set, the daemon AUTO-INSTALLS its Claude Code hooks into this path
     * (`~/.claude/settings.json`) on start whenever adoption is enabled — no manual `telecode hooks install`.
     * `hookCommand` is what Claude Code runs for each hook event (the daemon's own `"<bin>" hook`). Omitted →
     * no auto-install (the hooks are managed only via the CLI). Disabling adoption uninstalls them.
     */
    readonly settingsPath?: string;
    readonly hookCommand?: string;
    /** Hook `timeout` in seconds for the auto-install (AD-3 long timeout); default 3600 in installHooks. */
    readonly hookTimeoutSeconds?: number;
  };
  readonly logger?: Logger;
}

export interface Daemon {
  /** Connect to the relay and resolve once the relay has acknowledged registration. */
  start(): Promise<void>;
  /** Close the connection. */
  stop(): Promise<void>;
}

export function createDaemon(options: DaemonOptions): Daemon {
  const log = options.logger ?? pino({ name: 'daemon' });
  const agentAdapter = options.agentAdapter ?? createClaudeAgentAdapter({ logger: log });
  const worktreeManager = options.worktreeManager;
  const repoManager = options.repoManager;
  const defaultRepoPath = options.defaultRepoPath;
  const sessionStore = options.sessionStore;
  // E2E key management (Phase 3): holds the daemon private key + per-session content keys. Cleartext when
  // no keypair is configured (existing tests / pre-E2E daemons).
  const cipher = createSessionCipher(options.keyPair?.privateKey);
  // The per-machine adoption policy (Journey 3): enabled + denylist, managed from the web (sealed
  // `adopt.config`) and loaded on start. Default = adopt-all; the runtime gate in handleHookEvent applies it.
  let adoptConfig: AdoptSettings = DEFAULT_ADOPT_SETTINGS;
  let socket: WebSocket | null = null;
  // Reconnect state (Phase 4 Task 2): the daemon dials *out*, so a dropped link is its own to recover —
  // it redials with exponential backoff + jitter, keeping all in-memory session state, until stop().
  let stopped = false;
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether a browser is currently watching this device's channel (relay `viewer.presence`, the mirror of
  // `device.presence`). An ADOPTED session only holds a tool for a remote approval while an operator is
  // present; with nobody watching, the gate defers to Claude Code's own local prompt so telecode never
  // freezes an unwatched local session. Defaults false — a just-connected daemon assumes nobody is watching
  // until the relay reports the current state (it sends `viewer.presence` right after `hello.ack`).
  let isRemoteViewerOnline = false;
  const reconnectBaseMs = options.reconnect?.baseMs ?? 500;
  const reconnectMaxMs = options.reconnect?.maxMs ?? 10_000;
  // How long to await the relay's `session.chained` ACK for a handover continuation before falling back
  // (reuses the adopted-session ack timeout knob so tests can shrink it). Defaults to 10s.
  const chainAckTimeoutMs = options.adopt?.ackTimeoutMs ?? 10_000;

  // Outbound frames are built asynchronously (encryption is async), so we serialize them through a chain
  // to preserve stream order — a later `agent.message` must never overtake the `session.key` /
  // `session.started` it depends on. Mirrors the relay's per-connection processing queue.
  let sendChain: Promise<void> = Promise.resolve();
  function enqueueSend(buildFrame: () => Promise<string>): void {
    sendChain = sendChain
      .then(async () => {
        const frame = await buildFrame();
        socket?.send(frame);
      })
      .catch((err: unknown) => log.error({ err }, 'daemon: failed to send a frame'));
  }

  // Tool requests the agent is blocked on, keyed by the correlation id we send to the browser; each is
  // resolved when its matching `permission.decision` returns. Single-session in Phase 1, but keyed so it
  // stays correct as sessions multiply.
  // Carries the owning `sessionId` alongside the resolver so end/interrupt can settle a session's gates.
  const pendingPermissions = new Map<
    string,
    { sessionId: string | undefined; resolve: (decision: PermissionDecision) => void }
  >();
  // Adopted-session questions the hook is blocked on (Journey 2), keyed by the same correlation id we send
  // to the browser; each resolves when its `question.answer` returns. `null` settles it fail-closed (the
  // daemon is stopping, or the turn was interrupted/ended) so the hook defers to Claude Code's own picker.
  const pendingQuestions = new Map<
    string,
    { sessionId: string | undefined; resolve: (answers: QuestionAnswerItem[] | null) => void }
  >();
  // Free-form handover offers awaiting the user's answer (Journey 4), keyed by the correlation id sent to
  // the browser as `agent.handover`. Unlike `pendingPermissions`/`pendingQuestions` this is NOT a blocking
  // gate (the `Stop` hook already returned — the external process is idle): it is action-context storage so a
  // later `handover.answer` can fork-resume the right conversation (AD-J4-7). `externalSessionId` is the
  // adopted Claude `session_id` the fork resumes; `cwd` is the conversation's working directory.
  const pendingHandovers = new Map<
    string,
    {
      telecodeSessionId: string;
      externalSessionId: string;
      cwd: string | undefined;
      question: string;
      summary: string;
    }
  >();
  // Forked handover continuations awaiting the relay's minted child id, keyed by the daemon's clientRef; the
  // relay's `session.chained` ACK resolves the matching one (mirrors the adopted-session announce/ack pattern).
  const pendingChainRegistrations = new Map<string, (childSessionId: string) => void>();
  // The agent conversation id per telecode session, so a `user.message` follow-up resumes the same chat.
  const sdkSessions = new Map<string, string>();
  // The worktree cwd each session runs in, so every turn (launch + follow-ups) uses the same one.
  const sessionCwds = new Map<string, string>();
  // Telecode sessions with a turn in flight (one turn at a time per session).
  const activeRuns = new Set<string>();
  // The in-flight turn's abort handle per session (Task 9): interrupt/end abort it. Set at turn start,
  // cleared at turn end.
  const sessionAborts = new Map<string, AbortController>();
  // Sessions the operator has ended (Task 9): terminal — further follow-ups are refused.
  const endedSessions = new Set<string>();
  // The live transcript + status the daemon holds for each session (architecture invariant #3/#7: the
  // session lives on the laptop). A reopened browser re-attaches with `session.subscribe` and we backfill
  // this as `session.history` — so the relay never needs the plaintext (E2E-consistent in Phase 3). Kept
  // for the daemon's lifetime; a daemon restart loses it (Phase 4 resilience), reported as offline.
  // TODO(Phase 4): evict done/error records after a TTL so a long-lived daemon doesn't grow unbounded.
  interface SessionRecord {
    status: SessionStatusName;
    transcript: SessionHistoryEntry[];
    /** The mode the operator launched with; drives the per-tool gate (and is reused for follow-up turns). */
    permissionMode: PermissionModeName;
  }
  const sessionRecords = new Map<string, SessionRecord>();

  /** The record for a session, created on first use. */
  function recordFor(sessionId: string): SessionRecord {
    let existing = sessionRecords.get(sessionId);
    if (!existing) {
      existing = { status: 'starting', transcript: [], permissionMode: 'default' };
      sessionRecords.set(sessionId, existing);
    }
    return existing;
  }

  /** Append an entry to a session's transcript (no-op when the envelope carries no session id). */
  function record(sessionId: string | undefined, entry: SessionHistoryEntry): void {
    if (sessionId !== undefined) recordFor(sessionId).transcript.push(entry);
  }

  /** Set a session's tracked status (no-op when the envelope carries no session id). */
  function setStatus(sessionId: string | undefined, status: SessionStatusName): void {
    if (sessionId === undefined) return;
    const rec = recordFor(sessionId);
    rec.status = status;
    // Persist on the terminal states so a finished session survives a daemon restart (invariant #7). The
    // full transcript is already recorded by the time a turn settles to done/error, so this captures it. A
    // running/awaiting session is intentionally not persisted — it can't be resumed across a restart anyway.
    if ((status === 'done' || status === 'error') && sessionStore) {
      sessionStore.save(sessionId, {
        status,
        permissionMode: rec.permissionMode,
        transcript: rec.transcript,
      });
    }
  }

  /**
   * The authoritative history for a session — the daemon's own live record (status + transcript), or an
   * offline fallback for a session it no longer holds. Backfilled on `session.subscribe` (reconnect) and
   * sent to reconcile a `permission.decision` that raced a settle (see the decision handler).
   */
  function historyPayloadFor(sessionId: string | undefined): SessionHistoryPayload {
    const rec = sessionId !== undefined ? sessionRecords.get(sessionId) : undefined;
    return rec
      ? { status: rec.status, entries: rec.transcript }
      : { status: 'offline_paused', entries: [] };
  }

  /**
   * Seed sessions persisted by an earlier daemon run (invariant #7) so a reopened-but-finished session
   * backfills its real transcript instead of an empty offline record. In-memory sessions always win (there
   * are none at start), so this only adds ids the daemon doesn't already hold. Best-effort — never fails start.
   */
  async function restorePersistedSessions(): Promise<void> {
    if (!sessionStore) return;
    try {
      for (const [sessionId, persisted] of await sessionStore.loadAll()) {
        if (!sessionRecords.has(sessionId)) {
          sessionRecords.set(sessionId, {
            status: persisted.status,
            transcript: persisted.transcript,
            permissionMode: persisted.permissionMode,
          });
        }
      }
      log.info({ deviceId: options.deviceId }, 'daemon: restored persisted sessions');
    } catch (err) {
      log.warn({ err, deviceId: options.deviceId }, 'daemon: failed to restore persisted sessions');
    }
  }

  /**
   * The cleartext lifecycle status to stamp on a frame's envelope so the relay can update its registry
   * without reading the (encrypted) payload — only for the lifecycle types the relay acts on. Other types
   * carry their state in the payload (the relay derives those from the message `type`).
   */
  function cleartextStatusFor(type: MessageType, payload: unknown): SessionStatusName | undefined {
    if (type === 'session.ended') {
      const parsed = sessionEndedPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data.status : 'done';
    }
    return undefined;
  }

  /**
   * Send a session frame on the daemon's channel. For an E2E session the payload is sealed under the
   * session's content key (the relay only ever forwards ciphertext); lifecycle frames also carry the
   * cleartext `status` routing field. Cleartext sessions send the payload as-is (pre-E2E path).
   */
  function sendForSession(source: Envelope, type: MessageType, payload: unknown): void {
    const sessionId = source.session_id;
    const status = cleartextStatusFor(type, payload);
    enqueueSend(async () => {
      const fields: { payload: unknown; nonce: string } =
        sessionId !== undefined && cipher.isEncrypted(sessionId)
          ? await cipher.encrypt(sessionId, payload)
          : { payload, nonce: '' };
      return JSON.stringify(
        makeEnvelope({
          type,
          userId: source.user_id,
          deviceId: source.device_id,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(status !== undefined ? { status } : {}),
          payload: fields.payload,
          nonce: fields.nonce,
        }),
      );
    });
  }

  /** Deliver a session's content key, box-wrapped to a browser's ephemeral pubkey (`session.key`). */
  function deliverKey(source: Envelope, browserPublicKey: string): void {
    const sessionId = source.session_id;
    if (sessionId === undefined) return;
    enqueueSend(async () => {
      const fields = await cipher.keyDelivery(sessionId, browserPublicKey);
      return JSON.stringify(
        makeEnvelope({
          type: 'session.key',
          userId: source.user_id,
          deviceId: source.device_id,
          sessionId,
          payload: fields.payload,
          nonce: fields.nonce,
        }),
      );
    });
  }

  /**
   * Read an inbound session payload as plaintext: decrypt it under the session content key for an E2E
   * session (follow-up / decision / control are secretbox-sealed by the browser), or return it as-is in
   * cleartext mode.
   */
  async function readSessionPayload(envelope: Envelope): Promise<unknown> {
    const sessionId = envelope.session_id;
    if (sessionId !== undefined && cipher.isEncrypted(sessionId)) {
      return cipher.decrypt(envelope);
    }
    return envelope.payload;
  }

  /**
   * The human-in-the-loop gate: decide whether a tool the agent wants to run may proceed. Telecode's
   * own policy ({@link classifyTool}) is authoritative — a read-only tool auto-runs (no prompt, no
   * round-trip), while every consequential tool is forwarded to the browser as `agent.permission_request`
   * and the agent run is blocked on the returned promise until the matching `permission.decision` arrives.
   * The real adapter already forces this same policy via its `PreToolUse` hook; applying it here too makes
   * the in-process test adapter model production and backstops any tool that reaches the gate ungated.
   */
  function requestPermission(
    source: Envelope,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
    const mode =
      source.session_id !== undefined
        ? (sessionRecords.get(source.session_id)?.permissionMode ?? 'default')
        : 'default';
    if (classifyTool(request.toolName, mode) === 'allow') {
      // A read-only (or mode-permitted) tool — auto-approve without a human gate. The tool itself is still
      // streamed up as `agent.tool_use` (via the run's onEvent), so the transcript shows that it ran.
      log.debug(
        { deviceId: options.deviceId, sessionId: source.session_id, tool: request.toolName },
        'daemon: tool auto-approved by policy',
      );
      return Promise.resolve({ behavior: 'allow' });
    }
    const requestId = randomUUID();
    record(source.session_id, {
      kind: 'permission',
      requestId,
      toolName: request.toolName,
      input: request.input,
      decision: 'pending',
    });
    setStatus(source.session_id, 'awaiting_input');
    return new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(requestId, { sessionId: source.session_id, resolve });
      log.info(
        {
          deviceId: options.deviceId,
          sessionId: source.session_id,
          requestId,
          tool: request.toolName,
        },
        'daemon: permission requested',
      );
      sendForSession(source, 'agent.permission_request', {
        requestId,
        toolName: request.toolName,
        input: request.input,
      });
    });
  }

  /**
   * Forward an adopted session's `AskUserQuestion` to the browser as a structured `agent.question`, park the
   * session at `awaiting_input`, and block until the human's `question.answer` returns. Resolves with the
   * per-question answers, or `null` when the gate is settled without an answer (daemon stopping) so the
   * caller fails closed (defers to the local picker). Mirrors {@link requestPermission} but for questions.
   */
  function requestQuestionAnswer(
    source: Envelope,
    questions: AgentQuestionItem[],
  ): Promise<QuestionAnswerItem[] | null> {
    const requestId = randomUUID();
    record(source.session_id, { kind: 'question', requestId, questions });
    setStatus(source.session_id, 'awaiting_input');
    return new Promise<QuestionAnswerItem[] | null>((resolve) => {
      pendingQuestions.set(requestId, { sessionId: source.session_id, resolve });
      log.info(
        { deviceId: options.deviceId, sessionId: source.session_id, requestId },
        'daemon: question relayed to browser',
      );
      sendForSession(source, 'agent.question', { requestId, questions });
    });
  }

  /** Map a wire decision onto the adapter's internal contract (a deny always carries a message). */
  function toPermissionDecision(payload: PermissionDecisionPayload): PermissionDecision {
    if (payload.behavior === 'allow') {
      return payload.updatedInput !== undefined
        ? { behavior: 'allow', updatedInput: payload.updatedInput }
        : { behavior: 'allow' };
    }
    return { behavior: 'deny', message: payload.message ?? 'Denied by the operator' };
  }

  /**
   * Stop a session's in-flight turn (Task 9 interrupt/end): settle its pending gates with `deny` (so a
   * blocked `canUseTool` can't strand) — recording the verdict so a later backfill shows them decided —
   * then abort the run. Returns whether a turn was actually in flight.
   */
  function stopTurn(sessionId: string, reason: string): boolean {
    const sessionRecord = sessionRecords.get(sessionId);
    for (const [requestId, pending] of pendingPermissions) {
      if (pending.sessionId !== sessionId) continue;
      const entry = sessionRecord?.transcript.find(
        (e): e is Extract<SessionHistoryEntry, { kind: 'permission' }> =>
          e.kind === 'permission' && e.requestId === requestId,
      );
      if (entry) entry.decision = 'deny';
      pendingPermissions.delete(requestId);
      pending.resolve({ behavior: 'deny', message: reason });
    }
    // Release any adopted-session question the hook is blocked on for this session — same deadlock guard as
    // the permissions above. `null` fails it closed (the hook returns `ask`, deferring to the local picker);
    // adopted sessions have no AbortController, so without this an interrupt/end would strand the hook.
    for (const [requestId, pending] of pendingQuestions) {
      if (pending.sessionId !== sessionId) continue;
      pendingQuestions.delete(requestId);
      pending.resolve(null);
    }
    const abort = sessionAborts.get(sessionId);
    if (abort) {
      abort.abort();
      return true;
    }
    return false;
  }

  /** Apply an operator control (`interrupt` / `end`) to a session. */
  function handleControl(envelope: Envelope, action: SessionControlAction): void {
    const sessionId = envelope.session_id;
    if (sessionId === undefined) return;
    switch (action) {
      case 'interrupt': {
        // Like Esc: abort the in-flight turn; the aborted run ends cleanly (`done`) and the session stays
        // followable, so the human just sends another message to continue.
        const aborted = stopTurn(sessionId, 'interrupted by operator');
        log.info({ deviceId: options.deviceId, sessionId, aborted }, 'daemon: interrupt');
        return;
      }
      case 'end': {
        // Terminal: refuse future follow-ups, abort any in-flight turn. If none was running, end directly.
        endedSessions.add(sessionId);
        const aborted = stopTurn(sessionId, 'session ended by operator');
        log.info({ deviceId: options.deviceId, sessionId, aborted }, 'daemon: end');
        if (!aborted) {
          setStatus(sessionId, 'done');
          sendForSession(envelope, 'session.ended', { status: 'done' });
        }
        return;
      }
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  /** Optional per-turn configuration for {@link runTurn}. Ordinary launches/follow-ups leave most unset. */
  interface TurnOptions {
    /** Continue a prior agent conversation (from an earlier run's returned conversation id). */
    readonly resume?: string;
    /** The session's worktree cwd; omitted runs in the daemon cwd. */
    readonly cwd?: string;
    /** Fork the resumed conversation into a new one (free-form handover — a new id + its own transcript). */
    readonly forkSession?: boolean;
    /**
     * Journey 4: when `resume` is set and the resume run fails — e.g. the SDK can't pick up an
     * *externally-created* conversation (transcript gone, version skew) — the turn re-runs as a FRESH launch
     * (no resume/fork) seeded with this prompt, so a free-form handover still continues instead of dropping
     * the user's answer. Only used for the handover continuation; ordinary turns leave it unset.
     */
    readonly resumeFallbackPrompt?: string;
  }

  /**
   * Run one agent turn (the initial prompt or a follow-up) and stream its activity up, then end the
   * turn with `session.ended`. The returned conversation id is stored so the next `user.message` follow-up
   * resumes this same session. One turn at a time per session — a follow-up that races an in-flight turn is
   * dropped (the UI also blocks it). {@link TurnOptions} carries the optional per-turn configuration.
   */
  async function runTurn(
    envelope: Envelope,
    prompt: string,
    turn: TurnOptions = {},
  ): Promise<void> {
    const { resume, cwd, forkSession, resumeFallbackPrompt } = turn;
    const sessionId = envelope.session_id;
    if (sessionId !== undefined && activeRuns.has(sessionId)) {
      log.warn({ deviceId: options.deviceId, sessionId }, 'daemon: turn already running; dropped');
      return;
    }
    // A per-turn abort handle so interrupt/end (Task 9) can stop this run.
    const abort = new AbortController();
    if (sessionId !== undefined) {
      activeRuns.add(sessionId);
      sessionAborts.set(sessionId, abort);
    }
    const permissionMode =
      sessionId !== undefined ? sessionRecords.get(sessionId)?.permissionMode : undefined;
    // Options shared by both the resume attempt and the seeded-fresh fallback (only prompt/resume/fork differ).
    const baseOptions: Omit<AgentRunOptions, 'resume' | 'forkSession'> = {
      canUseTool: (request) => requestPermission(envelope, request),
      signal: abort.signal,
      ...(cwd !== undefined ? { cwd } : {}),
      ...(permissionMode !== undefined ? { permissionMode } : {}),
      onEvent: (event) => {
        if (event.type === 'message') {
          record(sessionId, { kind: 'message', text: event.text });
          sendForSession(envelope, 'agent.message', { text: event.text });
        } else {
          record(sessionId, { kind: 'tool', toolName: event.toolName, input: event.input });
          sendForSession(envelope, 'agent.tool_use', {
            toolName: event.toolName,
            input: event.input,
          });
        }
      },
    };
    try {
      let result: AgentRunResult;
      try {
        result = await agentAdapter.run(prompt, {
          ...baseOptions,
          ...(resume !== undefined ? { resume } : {}),
          ...(forkSession !== undefined ? { forkSession } : {}),
        });
      } catch (resumeErr) {
        // A failed resume of an externally-created conversation is recoverable: continue the handover as a
        // fresh, summary-seeded launch so the user's answer isn't lost. An operator abort is not recoverable.
        if (abort.signal.aborted || resume === undefined || resumeFallbackPrompt === undefined) {
          throw resumeErr;
        }
        log.warn(
          { err: resumeErr, deviceId: options.deviceId, sessionId },
          'daemon: resume failed — falling back to a summary-seeded fresh launch',
        );
        result = await agentAdapter.run(resumeFallbackPrompt, baseOptions);
      }
      if (sessionId !== undefined && result.sessionId !== undefined) {
        sdkSessions.set(sessionId, result.sessionId);
      }
      log.info({ deviceId: options.deviceId, sessionId }, 'daemon: turn ended');
      setStatus(sessionId, 'done');
      sendForSession(envelope, 'session.ended', { status: 'done' });
    } catch (err) {
      // An aborted run is an operator interrupt/end, not a failure — end the turn cleanly as `done`.
      if (abort.signal.aborted) {
        log.info({ deviceId: options.deviceId, sessionId }, 'daemon: turn interrupted');
        setStatus(sessionId, 'done');
        sendForSession(envelope, 'session.ended', { status: 'done' });
      } else {
        log.error({ err, sessionId }, 'daemon: turn failed');
        setStatus(sessionId, 'error');
        sendForSession(envelope, 'session.ended', {
          status: 'error',
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    } finally {
      if (sessionId !== undefined) {
        activeRuns.delete(sessionId);
        sessionAborts.delete(sessionId);
      }
    }
  }

  /** Returned by {@link prepareWorkspace} when prep failed and the session was already ended with error. */
  const FAILED = Symbol('workspace-failed');

  /**
   * Resolve the on-disk repo a session runs against: clone the launch's `repo` on demand (Task 8), or use
   * the daemon's configured `defaultRepoPath` (a local checkout). `undefined` means run in the daemon cwd.
   */
  async function resolveRepoPath(launch: SessionLaunchPayload): Promise<string | undefined> {
    if (launch.repo && repoManager) {
      return repoManager.ensureClone(launch.repo);
    }
    return defaultRepoPath;
  }

  /**
   * Prepare the session's workspace — clone its repo (if any) then cut its git worktree — and return the
   * worktree path as the agent cwd, caching it so every turn reuses it. Returns `undefined` to run in the
   * daemon cwd (no worktree manager, or no repo resolved). On failure it ends the session with an error and
   * returns {@link FAILED} so the launch aborts (it must never stick at `starting`).
   */
  async function prepareWorkspace(
    envelope: Envelope,
    launch: SessionLaunchPayload,
  ): Promise<string | undefined | typeof FAILED> {
    const sessionId = envelope.session_id;
    if (!worktreeManager || sessionId === undefined) return undefined;
    try {
      const repoPath = await resolveRepoPath(launch);
      if (repoPath === undefined) return undefined;
      const worktree = await worktreeManager.ensureWorktree(sessionId, repoPath);
      sessionCwds.set(sessionId, worktree.path);
      // Log owner/name + branch only — never the clone URL or local paths (kept out of log sinks).
      log.info(
        {
          deviceId: options.deviceId,
          sessionId,
          branch: worktree.branch,
          ...(launch.repo ? { repo: `${launch.repo.owner}/${launch.repo.name}` } : {}),
        },
        'daemon: session workspace ready',
      );
      return worktree.path;
    } catch (err) {
      log.error(
        { err, deviceId: options.deviceId, sessionId },
        'daemon: failed to prepare workspace',
      );
      setStatus(sessionId, 'error');
      sendForSession(envelope, 'session.ended', {
        status: 'error',
        error: 'failed to prepare session workspace',
      });
      return FAILED;
    }
  }

  /** Launch a new session: announce it started, then run the first turn. */
  async function runSession(envelope: Envelope): Promise<void> {
    // E2E: the launch payload is box-sealed to this daemon. Decrypt it, mint the session's content key,
    // and deliver it (session.key) to the launching browser before any encrypted stream frame.
    let launchPayload: unknown = envelope.payload;
    const browserPublicKey = envelope.sender_public_key;
    if (cipher.enabled && browserPublicKey !== undefined && envelope.session_id !== undefined) {
      try {
        launchPayload = await cipher.decryptLaunch(envelope);
      } catch (err) {
        log.warn({ err, deviceId: options.deviceId }, 'daemon: could not decrypt session.launch');
        sendForSession(envelope, 'session.ended', {
          status: 'error',
          error: 'could not decrypt launch',
        });
        return;
      }
      cipher.establish(envelope.session_id);
      deliverKey(envelope, browserPublicKey);
    }
    const launch = sessionLaunchPayloadSchema.safeParse(launchPayload);
    if (!launch.success) {
      // The relay already minted a `starting` row; fail it cleanly so it can't stick at `starting`.
      log.warn(
        { deviceId: options.deviceId },
        'daemon: rejected session.launch with invalid payload',
      );
      sendForSession(envelope, 'session.ended', {
        status: 'error',
        error: 'invalid launch payload',
      });
      return;
    }
    log.info(
      { deviceId: options.deviceId, sessionId: envelope.session_id },
      'daemon: session launch received',
    );
    // Prepare this session's workspace (clone-on-demand + worktree) before any agent work, so parallel
    // sessions never share a cwd. A failure here fails the launch cleanly — it must never stick at `starting`.
    const cwd = await prepareWorkspace(envelope, launch.data);
    if (cwd === FAILED) return;
    // Remember the operator's chosen mode so every turn (this one and follow-ups) gates tools the same way.
    if (envelope.session_id !== undefined && launch.data.permissionMode !== undefined) {
      recordFor(envelope.session_id).permissionMode = launch.data.permissionMode;
    }
    record(envelope.session_id, { kind: 'user', text: launch.data.prompt });
    setStatus(envelope.session_id, 'running');
    // Echo the launch's correlation id so the launching browser can pair the relay-minted session id.
    sendForSession(
      envelope,
      'session.started',
      launch.data.clientRef !== undefined ? { clientRef: launch.data.clientRef } : {},
    );
    await runTurn(envelope, launch.data.prompt, { ...(cwd !== undefined ? { cwd } : {}) });
  }

  /** Run a follow-up turn for an existing session by resuming its agent conversation. */
  async function runFollowUp(envelope: Envelope): Promise<void> {
    const message = userMessagePayloadSchema.safeParse(await readSessionPayload(envelope));
    if (!message.success) {
      log.warn({ deviceId: options.deviceId }, 'daemon: dropped user.message with invalid payload');
      return;
    }
    const sessionId = envelope.session_id;
    // An ended session takes no more turns (interrupt, by contrast, leaves the session followable).
    if (sessionId !== undefined && endedSessions.has(sessionId)) {
      log.warn(
        { deviceId: options.deviceId, sessionId },
        'daemon: follow-up refused — session ended',
      );
      return;
    }
    const resume = sessionId !== undefined ? sdkSessions.get(sessionId) : undefined;
    if (resume === undefined) {
      log.warn(
        { deviceId: options.deviceId, sessionId },
        'daemon: no agent conversation to resume for follow-up',
      );
      return;
    }
    log.info({ deviceId: options.deviceId, sessionId }, 'daemon: follow-up received');
    record(sessionId, { kind: 'user', text: message.data.text });
    setStatus(sessionId, 'running');
    // Reuse the session's worktree cwd (set on launch) so the follow-up turn runs in the same place.
    const cwd = sessionId !== undefined ? sessionCwds.get(sessionId) : undefined;
    await runTurn(envelope, message.data.text, { resume, ...(cwd !== undefined ? { cwd } : {}) });
  }

  async function handleFrame(raw: Buffer, onReady: () => void): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(raw.toString()));
    } catch (err) {
      log.warn({ err }, 'daemon: dropped invalid envelope');
      return;
    }

    switch (envelope.type) {
      case 'hello.ack': {
        // A successful (re-)registration resets the backoff so the next drop starts fresh.
        reconnectAttempts = 0;
        log.info({ deviceId: options.deviceId }, 'daemon: registered with relay');
        onReady();
        // Reconcile the registry: tell the relay which sessions we still hold so it can retire any OTHERS
        // left stale (a revoke/restart leaves `running`/`awaiting_input` rows the daemon no longer has —
        // otherwise they show as phantom "awaiting" in the dashboard and resurrect on every refresh). Sent
        // on every (re)registration; cleartext session ids only. Routed through the outbound chain like every
        // other send, so a frame a future hello.ack step might add can never overtake or be overtaken by it.
        enqueueSend(async () => reconcileFrame());
        return;
      }
      case 'echo': {
        const echo = echoPayloadSchema.safeParse(envelope.payload);
        if (!echo.success) {
          log.warn({ deviceId: options.deviceId }, 'daemon: dropped echo with invalid payload');
          return;
        }
        const { text } = echo.data;
        // Never log the payload text (CLAUDE.md: no plaintext in logs).
        log.info({ deviceId: options.deviceId }, 'daemon: echo received');
        socket?.send(
          JSON.stringify(
            makeEnvelope({
              type: 'echo.reply',
              userId: envelope.user_id,
              deviceId: envelope.device_id,
              ...(envelope.session_id !== undefined ? { sessionId: envelope.session_id } : {}),
              payload: { text },
            }),
          ),
        );
        return;
      }
      case 'session.launch': {
        void runSession(envelope);
        return;
      }
      case 'user.message': {
        void runFollowUp(envelope);
        return;
      }
      case 'session.subscribe': {
        if (!sessionSubscribePayloadSchema.safeParse(envelope.payload).success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped session.subscribe with invalid payload',
          );
          return;
        }
        // Reopen = reconnect: backfill the live transcript the daemon holds for this session. A daemon
        // that doesn't hold it (e.g. after a restart) can't backfill — report it not-live so the UI
        // falls back to the registry status instead of showing a phantom transcript.
        const sessionId = envelope.session_id;
        // E2E reconnect: re-deliver the session key to the (possibly new) browser pubkey it announced, so
        // it can decrypt the backfilled history that follows. Subscribe itself stays cleartext (`{}`).
        if (
          cipher.enabled &&
          envelope.sender_public_key !== undefined &&
          sessionId !== undefined &&
          cipher.isEncrypted(sessionId)
        ) {
          deliverKey(envelope, envelope.sender_public_key);
        }
        const rec = sessionId !== undefined ? sessionRecords.get(sessionId) : undefined;
        log.info(
          { deviceId: options.deviceId, sessionId, known: rec !== undefined },
          'daemon: session subscribe — backfilling history',
        );
        sendForSession(envelope, 'session.history', historyPayloadFor(sessionId));
        return;
      }
      case 'permission.decision': {
        const decision = permissionDecisionPayloadSchema.safeParse(
          await readSessionPayload(envelope),
        );
        if (!decision.success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped permission.decision with invalid payload',
          );
          return;
        }
        const pending = pendingPermissions.get(decision.data.requestId);
        if (!pending) {
          // The gate was already settled + removed (interrupt/end) before this decision arrived — the
          // interrupt-then-approve race. Dropping it silently strands the browser's "Approving…"
          // spinner forever; instead reconcile it with the authoritative session state (status + the
          // recorded verdict), exactly as a reopen's backfill would.
          log.info(
            { deviceId: options.deviceId, requestId: decision.data.requestId },
            'daemon: decision for a settled gate — reconciling with session state',
          );
          sendForSession(envelope, 'session.history', historyPayloadFor(envelope.session_id));
          return;
        }
        pendingPermissions.delete(decision.data.requestId);
        // Record the verdict on the gate so a later backfill shows it decided, and resume the session.
        // In-place on the daemon's own mutable record (single-threaded; no await between find and write).
        const sessionId = envelope.session_id;
        if (sessionId !== undefined) {
          const entry = sessionRecords
            .get(sessionId)
            ?.transcript.find(
              (e): e is Extract<SessionHistoryEntry, { kind: 'permission' }> =>
                e.kind === 'permission' && e.requestId === decision.data.requestId,
            );
          if (entry) entry.decision = decision.data.behavior;
          setStatus(sessionId, 'running');
        }
        log.info(
          {
            deviceId: options.deviceId,
            requestId: decision.data.requestId,
            behavior: decision.data.behavior,
          },
          'daemon: permission decided',
        );
        pending.resolve(toPermissionDecision(decision.data));
        return;
      }
      case 'question.answer': {
        const answer = questionAnswerPayloadSchema.safeParse(await readSessionPayload(envelope));
        if (!answer.success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped question.answer with invalid payload',
          );
          return;
        }
        const pending = pendingQuestions.get(answer.data.requestId);
        if (!pending) {
          // The question was already settled (daemon restart / a stale or duplicate answer). Reconcile with
          // the authoritative session state — exactly as the permission-decision race does — so the browser's
          // "sending…" doesn't strand on a question that's no longer pending.
          log.info(
            { deviceId: options.deviceId, requestId: answer.data.requestId },
            'daemon: answer for a settled question — reconciling with session state',
          );
          sendForSession(envelope, 'session.history', historyPayloadFor(envelope.session_id));
          return;
        }
        pendingQuestions.delete(answer.data.requestId);
        // Record the answer on the question entry so a later backfill shows it answered, then resume.
        const sessionId = envelope.session_id;
        if (sessionId !== undefined) {
          const entry = sessionRecords
            .get(sessionId)
            ?.transcript.find(
              (e): e is Extract<SessionHistoryEntry, { kind: 'question' }> =>
                e.kind === 'question' && e.requestId === answer.data.requestId,
            );
          if (entry) entry.answers = answer.data.answers;
          setStatus(sessionId, 'running');
        }
        log.info(
          { deviceId: options.deviceId, requestId: answer.data.requestId },
          'daemon: question answered',
        );
        pending.resolve(answer.data.answers);
        return;
      }
      case 'handover.answer': {
        await handleHandoverAnswer(envelope);
        return;
      }
      case 'session.control': {
        const control = sessionControlPayloadSchema.safeParse(await readSessionPayload(envelope));
        if (!control.success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped session.control with invalid payload',
          );
          return;
        }
        handleControl(envelope, control.data.action);
        return;
      }
      case 'session.adopted': {
        handleAdoptedAck(envelope);
        return;
      }
      case 'session.chained': {
        handleChainedAck(envelope);
        return;
      }
      case 'adopt.config': {
        await handleAdoptConfig(envelope);
        return;
      }
      case 'viewer.presence': {
        // Relay tells us whether any browser is watching this channel (the mirror of device.presence). We
        // hold it so the adopted-session gate only blocks for a remote approval while an operator is present.
        const presence = viewerPresencePayloadSchema.safeParse(envelope.payload);
        if (!presence.success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped viewer.presence with invalid payload',
          );
          return;
        }
        isRemoteViewerOnline = presence.data.online;
        log.debug(
          { deviceId: options.deviceId, online: isRemoteViewerOnline },
          'daemon: viewer presence updated',
        );
        return;
      }
      default:
        log.debug({ type: envelope.type }, 'daemon: ignoring message');
    }
  }

  /** The cleartext `hello` that registers this daemon for `(userId, deviceId)` on (re)connect. */
  function helloFrame(): string {
    return JSON.stringify(
      makeEnvelope({
        type: 'hello',
        userId: options.userId,
        deviceId: options.deviceId,
        payload: {
          role: 'daemon',
          ...(options.deviceToken !== undefined ? { token: options.deviceToken } : {}),
        },
      }),
    );
  }

  /**
   * The `session.reconcile` frame: the ids of the sessions this daemon currently holds in memory. The relay
   * retires any OTHER non-terminal session for this device — clearing stale `running`/`awaiting_input` rows
   * a revoke/restart left behind (the daemon persists only terminal sessions across a restart, so a lost
   * running/awaiting one is genuinely gone). Cleartext routing metadata (session ids only), E2E-safe.
   */
  function reconcileFrame(): string {
    return JSON.stringify(
      makeEnvelope({
        type: 'session.reconcile',
        userId: options.userId,
        deviceId: options.deviceId,
        payload: { heldSessionIds: [...sessionRecords.keys()] },
      }),
    );
  }

  /**
   * Open one relay connection and wire its lifecycle. Called on first connect and on every reconnect.
   * `onReady` fires on each `hello.ack`; `onFirstError` (first connect only) lets {@link start} reject a
   * failed initial dial. An unexpected `close` schedules a redial — the daemon recovers its own link.
   */
  function openConnection(onReady: () => void, onFirstError?: (err: unknown) => void): void {
    // `onFirstError` is passed only on the very first dial (from `start()`); reconnects omit it. So its
    // presence is what distinguishes an initial-connect rejection (reject `start()`) from a revocation
    // that surfaced later on a reconnect (fire `onUnauthorized`).
    const ws = new WebSocket(options.relayUrl);
    socket = ws;
    // Reset viewer presence on every (re)dial: a stale `true` from before a drop must not gate an adopted
    // tool on a remote approval nobody can give during the reconnect gap. The relay re-asserts the real state
    // right after hello.ack; until then assume nobody is watching (defer to the local prompt — safe default).
    isRemoteViewerOnline = false;
    // Inbound frames are handled asynchronously (decryption is async) and chained so each is fully
    // handled before the next — a follow-up can't decrypt before the launch establishes the key. Each
    // socket gets its own chain; the cipher + outbound chain persist across reconnects.
    let inbound: Promise<void> = Promise.resolve();
    ws.on('message', (raw: Buffer) => {
      inbound = inbound
        .then(() => handleFrame(raw, onReady))
        .catch((err: unknown) => log.error({ err }, 'daemon: frame handling failed'));
    });
    ws.once('open', () => ws.send(helloFrame()));
    ws.once('error', (err: unknown) => onFirstError?.(err));
    ws.once('close', (code: number) => {
      // An intentional stop() is terminal; an unexpected drop redials so the daemon stays reachable.
      if (stopped) return;
      // A 4001 means the relay rejected our device token (revoked/invalid). Redialing the same dead token
      // would loop forever — stop, and route to re-pairing: reject the first connect, or signal a
      // revocation that surfaced on a reconnect. The composition root clears the credentials and re-pairs.
      if (code === WS_CLOSE_UNAUTHORIZED) {
        stopped = true;
        if (onFirstError) onFirstError(new DaemonUnauthorizedError());
        else options.onUnauthorized?.();
        return;
      }
      scheduleReconnect(onReady);
    });
  }

  /** Schedule a redial with exponential backoff + jitter (capped), until the daemon is stopped. */
  function scheduleReconnect(onReady: () => void): void {
    if (stopped || reconnectTimer !== null) return;
    const ceiling = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** reconnectAttempts);
    const delay = ceiling / 2 + Math.random() * (ceiling / 2); // full-jitter half-range
    reconnectAttempts += 1;
    log.warn(
      { deviceId: options.deviceId, attempt: reconnectAttempts },
      'daemon: relay link lost — reconnecting',
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openConnection(onReady);
    }, delay);
  }

  // ── Adopted sessions ──────────────────────────────────────────────────────────────────────────────
  // When `options.adopt` is set, the daemon listens on a local Unix socket for the `telecode hook` bridge
  // and brings externally-started Claude Code sessions under telecode's monitoring + approval gate. The
  // socket transport (`hook-socket`), the id manager (`adopted-sessions`), and the transcript mirror
  // (`transcript-mirror`) are wired together here.
  const transcriptMirrors = new Map<string, TranscriptMirror>();

  /** Announce a discovered external session to the relay (cleartext routing metadata, like session.launch). */
  function announceAdopted(payload: { clientRef: string; title?: string; cwd?: string }): void {
    // A `session_id`-less announce: routing metadata, always cleartext — it can't go through
    // sendForSession (which needs a source envelope), so the frame is built inline. makeEnvelope
    // defaults the nonce to '' (cleartext).
    enqueueSend(async () =>
      JSON.stringify(
        makeEnvelope({
          type: 'session.adopted',
          userId: options.userId,
          deviceId: options.deviceId,
          payload,
        }),
      ),
    );
  }

  /**
   * Pair the relay's `session.adopted` ACK (minted telecode id on the envelope, our clientRef echoed in
   * the payload) to its pending adoption. Ignores a malformed ACK, and — defense against a browser forging
   * a `session.adopted` that the relay forwards here — only resolves a clientRef we are actually awaiting,
   * so a forged/replayed ACK can't redirect the claude→telecode id mapping for a session it doesn't own.
   */
  function handleAdoptedAck(envelope: Envelope): void {
    if (!adoptedSessions || envelope.session_id === undefined) return;
    const ack = sessionAdoptedPayloadSchema.safeParse(envelope.payload);
    if (!ack.success) {
      log.warn({ deviceId: options.deviceId }, 'daemon: malformed session.adopted ack — dropping');
      return;
    }
    if (adoptedSessions.isPending(ack.data.clientRef)) {
      adoptedSessions.resolveAck(ack.data.clientRef, envelope.session_id);
    } else {
      log.warn({ deviceId: options.deviceId }, 'daemon: unexpected session.adopted ack — dropping');
    }
  }

  /**
   * Announce a forked handover continuation (Journey 4) to the relay and await the minted child id. The
   * relay mints an `origin='launched'` row linked to `parentSessionId` and ACKs with `session.chained`
   * (carrying the child's id + our clientRef, resolved in {@link handleChainedAck}). Symmetric with the
   * adopted-session announce/ack. Rejects if no ACK arrives within `ackTimeoutMs` so the caller can fall
   * back rather than hang. Routing metadata only (cleartext), like `session.adopted`.
   */
  function registerChained(payload: {
    clientRef: string;
    parentSessionId: string;
    title?: string;
    cwd?: string;
  }): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingChainRegistrations.delete(payload.clientRef);
        reject(new Error('session.chained ack timed out'));
      }, chainAckTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      pendingChainRegistrations.set(payload.clientRef, (childSessionId) => {
        clearTimeout(timer);
        resolve(childSessionId);
      });
      enqueueSend(async () =>
        JSON.stringify(
          makeEnvelope({
            type: 'session.chained',
            userId: options.userId,
            deviceId: options.deviceId,
            payload,
          }),
        ),
      );
    });
  }

  /** Pair the relay's `session.chained` ACK (minted child id on the envelope, our clientRef echoed) to its
   * pending registration. Only resolves a clientRef we are awaiting, so a forged ACK can't inject a child. */
  function handleChainedAck(envelope: Envelope): void {
    if (envelope.session_id === undefined) return;
    const ack = sessionChainedPayloadSchema.safeParse(envelope.payload);
    if (!ack.success) {
      log.warn({ deviceId: options.deviceId }, 'daemon: malformed session.chained ack — dropping');
      return;
    }
    const resolve = pendingChainRegistrations.get(ack.data.clientRef);
    if (resolve) {
      pendingChainRegistrations.delete(ack.data.clientRef);
      resolve(envelope.session_id);
    } else {
      log.warn({ deviceId: options.deviceId }, 'daemon: unexpected session.chained ack — dropping');
    }
  }

  /** Whether telecode's Claude Code hooks are installed, and for which events — the setup status the UI shows. */
  async function fetchHookInstallStatus(): Promise<{ installed: boolean; events: string[] }> {
    const settingsPath = options.adopt?.settingsPath;
    if (settingsPath === undefined) return { installed: false, events: [] };
    try {
      return await readHooksStatus({ settingsPath });
    } catch (err) {
      log.warn({ err, deviceId: options.deviceId }, 'daemon: could not read adoption hook status');
      return { installed: false, events: [] };
    }
  }

  /**
   * Apply the hook install-state the persisted `enabled` flag demands — the heart of frictionless setup:
   * adoption enabled → auto-install telecode's Claude Code hooks (idempotent, no manual step); disabled →
   * uninstall them (telecode backs out of `~/.claude` entirely). No-op without a configured settings path /
   * hook command. FAIL-SOFT: a settings-write error never crashes the daemon — the UI then shows
   * hooks-not-installed and the web toggle can retry.
   */
  async function applyHookInstallState(): Promise<void> {
    const settingsPath = options.adopt?.settingsPath;
    const command = options.adopt?.hookCommand;
    if (settingsPath === undefined || command === undefined) return;
    try {
      if (adoptConfig.enabled) {
        await installHooks({
          settingsPath,
          command,
          ...(options.adopt?.hookTimeoutSeconds !== undefined
            ? { timeoutSeconds: options.adopt.hookTimeoutSeconds }
            : {}),
        });
        log.info({ deviceId: options.deviceId }, 'daemon: adoption hooks installed automatically');
      } else {
        await uninstallHooks({ settingsPath });
        log.info({ deviceId: options.deviceId }, 'daemon: adoption disabled — hooks removed');
      }
    } catch (err) {
      log.warn({ err, deviceId: options.deviceId }, 'daemon: could not apply adoption hook state');
    }
  }

  /** The `adopt.state` payload: the current policy plus the live hook-install status (for the web to render). */
  async function buildAdoptState(): Promise<AdoptStatePayload> {
    const { installed, events } = await fetchHookInstallStatus();
    return { ...adoptConfig, hooksInstalled: installed, events };
  }

  /**
   * Handle a sealed `adopt.config` (web → daemon, Journey 3): open it under the device shared key, optionally
   * persist + apply a new policy (installing/uninstalling the hooks to match — Journey "frictionless setup"),
   * then reply the current policy + setup status as `adopt.state` sealed back to the requesting browser. The
   * relay only ever sees ciphertext, so the denylist's repo paths never leave the machine in the clear
   * (invariant #5). Cleartext on a pre-E2E daemon (no keypair).
   */
  async function handleAdoptConfig(envelope: Envelope): Promise<void> {
    let payload: unknown;
    try {
      payload = cipher.enabled ? await cipher.openFromBrowser(envelope) : envelope.payload;
    } catch (err) {
      log.warn(
        { err, deviceId: options.deviceId },
        'daemon: could not open adopt.config — dropping',
      );
      return;
    }
    const parsed = adoptConfigPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      log.warn({ deviceId: options.deviceId }, 'daemon: dropped adopt.config with invalid payload');
      return;
    }
    if (parsed.data.set) {
      adoptConfig = parsed.data.set;
      if (options.adopt?.configPath) await saveAdoptConfig(options.adopt.configPath, adoptConfig);
      // The enabled toggle DRIVES hook install/uninstall (one control, from the browser): enabling installs
      // the hooks, disabling backs telecode out of ~/.claude entirely.
      await applyHookInstallState();
      // Log the shape, never the denylist paths (they can name private repos — keep them out of log sinks).
      log.info(
        {
          deviceId: options.deviceId,
          enabled: adoptConfig.enabled,
          denylistCount: adoptConfig.denylist.length,
        },
        'daemon: adoption policy updated',
      );
    }
    // Reply the current policy + setup status, sealed to the requesting browser so repo paths never reach the relay.
    const browserPublicKey = envelope.sender_public_key;
    const state = await buildAdoptState();
    enqueueSend(async () => {
      const fields: { payload: unknown; nonce: string } =
        cipher.enabled && browserPublicKey !== undefined
          ? await cipher.sealToBrowser(browserPublicKey, state)
          : { payload: state, nonce: '' };
      return JSON.stringify(
        makeEnvelope({
          type: 'adopt.state',
          userId: options.userId,
          deviceId: options.deviceId,
          payload: fields.payload,
          nonce: fields.nonce,
        }),
      );
    });
  }

  const adoptedSessions: AdoptedSessionManager | undefined = options.adopt
    ? createAdoptedSessionManager({
        announce: announceAdopted,
        ...(options.adopt.ackTimeoutMs !== undefined
          ? { ackTimeoutMs: options.adopt.ackTimeoutMs }
          : {}),
        logger: log,
      })
    : undefined;

  /**
   * A synthetic `source` envelope so adopted sessions reuse the session send + gate helpers. Uses
   * `type: 'session.adopted'` only as a sentinel source type; each {@link sendForSession} call supplies
   * the real frame type. (Frames are cleartext on a pre-E2E daemon and E2E-encrypted once a content key
   * is established — see {@link handleHookEvent}.)
   */
  function adoptedSource(telecodeSessionId: string): Envelope {
    return makeEnvelope({
      type: 'session.adopted',
      userId: options.userId,
      deviceId: options.deviceId,
      sessionId: telecodeSessionId,
      payload: {},
    });
  }

  /** Pull transcript lines appended since the last event into the session record + push them to browsers. */
  async function mirrorTranscript(
    telecodeSessionId: string,
    transcriptPath: string | undefined,
  ): Promise<void> {
    if (transcriptPath === undefined) return;
    let mirror = transcriptMirrors.get(telecodeSessionId);
    if (!mirror) {
      mirror = createTranscriptMirror({ path: transcriptPath, logger: log });
      transcriptMirrors.set(telecodeSessionId, mirror);
    }
    const entries = await mirror.sync();
    if (entries.length === 0) return;
    for (const entry of entries) record(telecodeSessionId, entry);
    // Push the full transcript so the browser sees every kind — including the user's own prompts, which it
    // never sent for an adopted session. Heavier than per-line streaming but correct for the walking
    // skeleton (a later pass can stream incrementally + dedupe against the gate's permission entries).
    sendForSession(
      adoptedSource(telecodeSessionId),
      'session.history',
      historyPayloadFor(telecodeSessionId),
    );
  }

  /**
   * Handle a `handover.answer` (Journey 4): the user chose to take over an adopted session's free-form
   * question. This is an action trigger, not a gate resolution — it launches a forked telecode-owned
   * continuation (see {@link launchHandoverContinuation}) and marks the parent handed-off. A duplicate/late
   * answer (already-settled offer) reconciles with the authoritative session state so the browser's
   * "taking over…" doesn't hang.
   */
  async function handleHandoverAnswer(envelope: Envelope): Promise<void> {
    const answer = handoverAnswerPayloadSchema.safeParse(await readSessionPayload(envelope));
    if (!answer.success) {
      log.warn(
        { deviceId: options.deviceId },
        'daemon: dropped handover.answer with invalid payload',
      );
      return;
    }
    const handover = pendingHandovers.get(answer.data.requestId);
    if (!handover) {
      log.info(
        { deviceId: options.deviceId, requestId: answer.data.requestId },
        'daemon: handover.answer for a settled offer — reconciling with session state',
      );
      sendForSession(envelope, 'session.history', historyPayloadFor(envelope.session_id));
      return;
    }
    pendingHandovers.delete(answer.data.requestId);
    // Record the answer on the parent's handover entry so a later backfill shows it resolved.
    const parentId = handover.telecodeSessionId;
    const entry = sessionRecords
      .get(parentId)
      ?.transcript.find(
        (e): e is Extract<SessionHistoryEntry, { kind: 'handover' }> =>
          e.kind === 'handover' && e.requestId === answer.data.requestId,
      );
    if (entry) entry.answerText = answer.data.answerText;
    log.info(
      { deviceId: options.deviceId, sessionId: parentId, requestId: answer.data.requestId },
      'daemon: handover accepted — launching continuation',
    );
    // Fire-and-forget: the launch runs a long agent turn, so it must not block the inbound frame chain. Its
    // own paths are exception-safe, but the `.catch` guards against a synchronous throw so an error can never
    // vanish silently (a detached `void` promise is not covered by the inbound chain's catch).
    void launchHandoverContinuation(
      adoptedSource(parentId),
      handover,
      answer.data.answerText,
    ).catch((err: unknown) =>
      log.error(
        { err, deviceId: options.deviceId, sessionId: parentId },
        'daemon: handover continuation failed',
      ),
    );
  }

  /**
   * Take over an adopted session's free-form question (Journey 4): launch a forked, telecode-OWNED
   * continuation that resumes the adopted conversation (`resume` + `forkSession`, from the spike) with the
   * user's answer as its next turn, and mark the parent adopted row handed-off (read-only, linked). The fork
   * inherits full context but gets a NEW session id + its own transcript, so it never writes into the still-
   * live external process's transcript. `source` is the parent's source envelope (for its `session.ended`).
   */
  async function launchHandoverContinuation(
    source: Envelope,
    handover: {
      telecodeSessionId: string;
      externalSessionId: string;
      cwd: string | undefined;
      question: string;
      summary: string;
    },
    answerText: string,
  ): Promise<void> {
    const parentId = handover.telecodeSessionId;
    const clientRef = randomUUID();
    const title = `Continue: ${handover.question.slice(0, HANDOVER_TITLE_PREVIEW_CHARS)}`;
    let childId: string;
    try {
      childId = await registerChained({
        clientRef,
        parentSessionId: parentId,
        title,
        ...(handover.cwd !== undefined ? { cwd: handover.cwd } : {}),
      });
    } catch (err) {
      // The relay never minted the child (offline / dropped). Leave the parent as-is; a later answer can
      // retry. (Journey 4 T2 adds the summary-seeded fresh-launch fallback for a resume that errors.)
      log.warn(
        { err, deviceId: options.deviceId, sessionId: parentId },
        'daemon: handover continuation registration failed',
      );
      return;
    }
    const childSource = adoptedSource(childId);
    // The child is a telecode-owned launched session; encrypt its frames under E2E (the browser receives the
    // content key when it subscribes, exactly like an adopted session). Cleartext only on a pre-E2E daemon.
    if (cipher.enabled) cipher.establish(childId);
    recordFor(childId).permissionMode = 'default';
    record(childId, { kind: 'user', text: answerText });
    setStatus(childId, 'running');
    sendForSession(childSource, 'session.started', {});
    // Migrate the conversation: the parent adopted row is handed off (terminal, read-only) — the child now
    // carries it forward. Ended promptly (before the long turn) so the dashboard reflects the migration.
    setStatus(parentId, 'done');
    sendForSession(source, 'session.ended', { status: 'done' });
    log.info(
      { deviceId: options.deviceId, parentSessionId: parentId, sessionId: childId },
      'daemon: handover continuation launched (forked resume)',
    );
    // Run the forked continuation: resume the adopted conversation by its Claude id, fork it, seed the answer.
    // If the resume fails (an externally-created conversation the SDK can't pick up), fall back to a fresh
    // launch seeded with the handover context so the answer still lands (AD-7 fallback).
    const resumeFallbackPrompt = buildHandoverFallbackPrompt(
      handover.summary,
      handover.question,
      answerText,
    );
    await runTurn(childSource, answerText, {
      resume: handover.externalSessionId,
      ...(handover.cwd !== undefined ? { cwd: handover.cwd } : {}),
      forkSession: true,
      resumeFallbackPrompt,
    });
  }

  /**
   * SessionEnd (Journey 3): the Claude Code process exited. End the adopted session if we are tracking it —
   * never force-adopt an unknown session just to end it (no phantom row). Until now adopted sessions never
   * received a `session.ended` and lingered as running forever. A final transcript mirror captures any
   * trailing lines before the terminal frame. Idempotent (a re-fired SessionEnd won't re-end).
   */
  async function handleSessionEndHook(event: HookEvent): Promise<unknown> {
    const knownId = adoptedSessions?.telecodeIdFor(event.session_id);
    if (knownId !== undefined) {
      await mirrorTranscript(knownId, event.transcript_path);
      const status = recordFor(knownId).status;
      if (status !== 'done' && status !== 'error') {
        if (cipher.enabled) cipher.establish(knownId); // idempotent; session.ended must encrypt under E2E
        setStatus(knownId, 'done');
        sendForSession(adoptedSource(knownId), 'session.ended', { status: 'done' });
        log.info(
          { deviceId: options.deviceId, sessionId: knownId },
          'daemon: adopted session ended',
        );
      }
    }
    return {};
  }

  /**
   * Notification (Journey 3): a non-blocking attention cue (e.g. the session went idle waiting for input).
   * Surface it only for a session we already track — never force-adopt on a stray notification. The
   * `awaiting_input` guard is about gate STATE (a permission-prompt notification is redundant while a gate
   * shows), not rate-limiting — several idle notices are fine; the web clears each on the next frame.
   */
  function handleNotificationHook(event: HookEvent): unknown {
    const knownId = adoptedSessions?.telecodeIdFor(event.session_id);
    if (
      knownId !== undefined &&
      event.message !== undefined &&
      event.message.length > 0 &&
      recordFor(knownId).status !== 'awaiting_input'
    ) {
      if (cipher.enabled) cipher.establish(knownId); // idempotent; the notice must encrypt under E2E
      sendForSession(adoptedSource(knownId), 'agent.notice', { message: event.message });
      log.info(
        { deviceId: options.deviceId, sessionId: knownId },
        'daemon: adopted session notice',
      );
    }
    return {};
  }

  /**
   * Stop (Journey 4): the adopted session ended its turn. If its last assistant message looks like a
   * free-form question (heuristic, {@link isFreeFormQuestion}), offer to take it over: emit a non-blocking
   * `agent.handover` carrying the exact question + a handover summary, park the session at `awaiting_input`,
   * and remember the context so a later `handover.answer` can fork-resume the conversation. NON-blocking —
   * the hook returns `{}` immediately (the idle external process is never held). Acts only on a tracked
   * session; skips the re-entrancy case (`stop_hook_active`) and never offers twice (already awaiting input).
   */
  async function handleStopHook(event: HookEvent): Promise<unknown> {
    const knownId = adoptedSessions?.telecodeIdFor(event.session_id);
    if (knownId === undefined) return {};
    if (event.stop_hook_active === true) return {};
    // Mirror the turn's final transcript on EVERY Stop. A turn's tail — the assistant's last message after
    // the final `PreToolUse` (or an entire text-only reply, which fires no PreToolUse at all) — is otherwise
    // never captured, so it goes MISSING from the telecode view. This runs regardless of the handover path
    // below. E2E: establish the key first so the streamed entries encrypt. Fail-soft: an unreadable transcript
    // is logged and skipped (the session keeps running locally).
    if (cipher.enabled) cipher.establish(knownId);
    try {
      await mirrorTranscript(knownId, event.transcript_path);
    } catch (err) {
      log.warn(
        { err, deviceId: options.deviceId, sessionId: knownId },
        'daemon: transcript mirror failed on Stop',
      );
      return {};
    }

    // Free-form handover offer (Journey 4): only when the turn ended asking a free-form question AND the
    // policy still allows it — a repo since denylisted (or adoption turned off) must not get an offer, even
    // though the session was tracked before that change. Don't stack an offer while one is already showing.
    if (!isAdoptionAllowed(adoptConfig, event.cwd)) return {};
    if (!isFreeFormQuestion(event.last_assistant_message)) return {};
    if (recordFor(knownId).status === 'awaiting_input') return {};
    const question = (event.last_assistant_message ?? '').trim();
    // Deterministic "what the session was doing" summary from the mirrored transcript — no extra model call.
    const summary = buildHandoverSummary(recordFor(knownId).transcript);
    const requestId = randomUUID();
    pendingHandovers.set(requestId, {
      telecodeSessionId: knownId,
      externalSessionId: event.session_id,
      cwd: event.cwd,
      question,
      summary,
    });
    record(knownId, { kind: 'handover', requestId, question, summary });
    setStatus(knownId, 'awaiting_input');
    sendForSession(adoptedSource(knownId), 'agent.handover', { requestId, question, summary });
    log.info(
      { deviceId: options.deviceId, sessionId: knownId, requestId },
      'daemon: free-form handover offered',
    );
    return {};
  }

  /**
   * Forward an adopted session's `AskUserQuestion` (Journey 2): relay it to the browser and return the remote
   * pick as deny-feedback (best-effort, AD-4). Fails closed (`ask`) on an unparseable question or when no
   * remote answer arrives (daemon stopping), so Claude Code falls back to its own local picker.
   */
  async function handleAskUserQuestionHook(
    event: HookEvent,
    telecodeSessionId: string,
  ): Promise<unknown> {
    const questions = questionsFromToolInput(event.tool_input);
    if (!questions) {
      log.warn(
        { deviceId: options.deviceId, sessionId: telecodeSessionId },
        'daemon: could not parse AskUserQuestion — failing closed',
      );
      return preToolUseOutput('ask');
    }
    const answers = await requestQuestionAnswer(adoptedSource(telecodeSessionId), questions);
    // No remote answer (daemon stopping) — fail closed so Claude Code shows its own picker locally.
    if (answers === null) return preToolUseOutput('ask');
    return preToolUseOutput('deny', buildQuestionDenyReason(questions, answers));
  }

  /**
   * The gate for an adopted session's `PreToolUse`. Mirrors the LOCAL session's permission mode: a mode where
   * Claude Code never prompts (bypassPermissions / auto / dontAsk) DEFERS (`{}` — Claude Code's own mode runs
   * the tool); a read-only tool (or an acceptEdits edit) auto-allows; a consequential tool is held for a
   * REMOTE decision only while an operator is watching, else it defers to Claude Code's own local prompt so
   * telecode never freezes an unwatched local session. The deliberate opposite of a telecode-launched
   * session, which never surrenders its gate.
   */
  async function handlePreToolUseHook(
    event: HookEvent,
    toolName: string,
    telecodeSessionId: string,
  ): Promise<unknown> {
    const gate = adoptedGateDecision(toolName, event.permission_mode);
    if (gate === 'defer') return {};
    if (gate === 'allow') return preToolUseOutput('allow');
    // 'gate': the tool needs a human. Hold it for a remote decision only while an operator is watching this
    // channel; with nobody watching, defer so Claude Code's own local prompt/picker handles it (the "only
    // gate when watched" safety rule — relay `viewer.presence` drives `isRemoteViewerOnline`).
    if (!isRemoteViewerOnline) return {};
    if (toolName === 'AskUserQuestion') {
      return handleAskUserQuestionHook(event, telecodeSessionId);
    }
    const decision = await requestPermission(adoptedSource(telecodeSessionId), {
      toolName,
      input: event.tool_input ?? {},
    });
    return decision.behavior === 'allow'
      ? preToolUseOutput('allow')
      : preToolUseOutput('deny', decision.message);
  }

  /**
   * Handle one hook event from the bridge (the socket calls this). Lifecycle events (SessionEnd /
   * Notification / Stop) act only on a session we already track. Otherwise adopt the session (announce +
   * await the relay's minted id), mirror its transcript, and for a `PreToolUse` route the tool through
   * {@link handlePreToolUseHook}. FAIL-CLOSED (AD-2): any adoption failure returns `ask` / `{}`, so Claude
   * Code falls back to its own local prompt — never an auto-allow of a consequential tool because adoption
   * hit a snag.
   */
  async function handleHookEvent(event: HookEvent): Promise<unknown> {
    if (!adoptedSessions) return {};
    // Lifecycle events act only on a session we already track (never force-adopt to handle them).
    if (event.hook_event_name === 'SessionEnd') return handleSessionEndHook(event);
    if (event.hook_event_name === 'Notification') return handleNotificationHook(event);
    if (event.hook_event_name === 'Stop') return handleStopHook(event);

    // Adoption policy gate (Journey 3): for a session we are NOT already tracking, apply the per-machine
    // policy — if adoption is disabled or this project is on the denylist, telecode stays out entirely and
    // the session runs via Claude Code's own local flow. `{}` = no hook opinion. (An already-adopted session
    // keeps flowing — a mid-session policy change never strands an in-flight gate.)
    if (
      adoptedSessions.telecodeIdFor(event.session_id) === undefined &&
      !isAdoptionAllowed(adoptConfig, event.cwd)
    ) {
      return {};
    }

    let telecodeSessionId: string;
    try {
      // Name the registry row from the project directory (e.g. `…/myrepo` → "myrepo") so a session adopted
      // before any user prompt — esp. a chat-only one adopted on SessionStart — still reads sensibly in the
      // dashboard. Once the transcript mirrors a user message the UI can prefer that; the cwd title is the
      // sensible default. Adoption announces once, so this title comes from the first event we see.
      const title = event.cwd !== undefined ? basename(event.cwd) : '';
      telecodeSessionId = await adoptedSessions.ensureAdopted({
        claudeSessionId: event.session_id,
        ...(event.cwd !== undefined ? { cwd: event.cwd } : {}),
        ...(title !== '' ? { title } : {}),
      });
    } catch (err) {
      log.warn(
        { err, deviceId: options.deviceId },
        'daemon: could not adopt session — failing closed',
      );
      return preToolUseOutput('ask');
    }
    // An adopted session is live the moment we first see it.
    if (recordFor(telecodeSessionId).status === 'starting') setStatus(telecodeSessionId, 'running');
    // E2E (invariant #5): mint this session's content key so its frames go to the relay as ciphertext, not
    // plaintext. Idempotent. The key is delivered to the browser on `session.subscribe` (it announces its
    // pubkey then), exactly like a launched session's reconnect. Cleartext only on a pre-E2E daemon (tests).
    if (cipher.enabled) cipher.establish(telecodeSessionId);
    await mirrorTranscript(telecodeSessionId, event.transcript_path);

    if (event.hook_event_name === 'PreToolUse' && event.tool_name !== undefined) {
      return handlePreToolUseHook(event, event.tool_name, telecodeSessionId);
    }
    // Non-PreToolUse events (Notification/SessionStart/etc., Journey 3) only drove adoption + the mirror.
    return {};
  }

  const hookSocket: HookSocketServer | undefined = options.adopt
    ? createHookSocketServer({
        socketPath: options.adopt.socketPath,
        handle: handleHookEvent,
        logger: log,
      })
    : undefined;

  return {
    async start(): Promise<void> {
      await restorePersistedSessions();
      // Load the per-machine adoption policy (Journey 3) before listening for hook events, so the runtime
      // gate applies the user's saved denylist/enabled from the first event. No path → the adopt-all default.
      if (options.adopt?.configPath !== undefined) {
        adoptConfig = await loadAdoptConfig(options.adopt.configPath);
      }
      // Frictionless setup: bring adoption online with NO manual step — auto-install the Claude Code hooks
      // when adoption is enabled (the default), or ensure they're removed when the user has disabled it. A
      // local file write, independent of the relay; fail-soft (never blocks start).
      await applyHookInstallState();
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const onReady = (): void => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        const onFirstError = (err: unknown): void => {
          if (!settled) {
            settled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        openConnection(onReady, onFirstError);
      });
      // Listen for the `telecode hook` bridge only after the relay link is up, so an early hook event
      // (whose announce would be dropped on a not-yet-connected socket) is unlikely to fail closed.
      await hookSocket?.start();
    },

    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // Unblock any in-flight turns waiting on a human decision (incl. an adopted session's hook, which is
      // blocking the hook socket) so their runs finish instead of hanging on a closed socket. Settle BEFORE
      // stopping the hook socket, so a blocked hook gets its response rather than a dropped connection.
      for (const { resolve } of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'daemon stopping' });
      }
      pendingPermissions.clear();
      // Likewise release any adopted-session question the hook is blocked on — `null` fails it closed so the
      // hook defers to Claude Code's local picker (never auto-answered). Same J1 deadlock guard as above.
      for (const { resolve } of pendingQuestions.values()) {
        resolve(null);
      }
      pendingQuestions.clear();
      // Handover offers (Journey 4) are non-blocking — no hook is parked on them, so there is nothing to
      // resolve; just discard the context. Pending chain registrations can't be ACKed on a closed socket;
      // their timers are already `unref`'d, so clearing is for symmetry/tidiness.
      pendingHandovers.clear();
      pendingChainRegistrations.clear();
      await hookSocket?.stop();
      socket?.close();
      socket = null;
    },
  };
}
