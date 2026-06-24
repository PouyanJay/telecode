import { randomUUID } from 'node:crypto';

import { pino, type Logger } from 'pino';
import WebSocket from 'ws';

import {
  echoPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  sessionLaunchPayloadSchema,
  sessionSubscribePayloadSchema,
  userMessagePayloadSchema,
  type Envelope,
  type MessageType,
  type PermissionDecisionPayload,
  type SessionHistoryEntry,
  type SessionHistoryPayload,
  type SessionLaunchPayload,
  type SessionStatusName,
} from '@telecode/protocol';

import {
  type AgentAdapter,
  type PermissionDecision,
  type PermissionRequest,
} from './agent-adapter';
import { createClaudeAgentAdapter } from './claude-agent-adapter';
import { type RepoManager } from './sessions/repo-manager';
import { type WorktreeManager } from './sessions/worktree-manager';

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
  let socket: WebSocket | null = null;

  // Tool requests the agent is blocked on, keyed by the correlation id we send to the browser; each is
  // resolved when its matching `permission.decision` returns. Single-session in Phase 1, but keyed so it
  // stays correct as sessions multiply.
  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  // The agent conversation id per telecode session, so a `user.message` follow-up resumes the same chat.
  const sdkSessions = new Map<string, string>();
  // The worktree cwd each session runs in, so every turn (launch + follow-ups) uses the same one.
  const sessionCwds = new Map<string, string>();
  // Telecode sessions with a turn in flight (one turn at a time per session).
  const activeRuns = new Set<string>();
  // The live transcript + status the daemon holds for each session (architecture invariant #3/#7: the
  // session lives on the laptop). A reopened browser re-attaches with `session.subscribe` and we backfill
  // this as `session.history` — so the relay never needs the plaintext (E2E-consistent in Phase 3). Kept
  // for the daemon's lifetime; a daemon restart loses it (Phase 4 resilience), reported as offline.
  // TODO(Phase 4): evict done/error records after a TTL so a long-lived daemon doesn't grow unbounded.
  const sessionRecords = new Map<
    string,
    { status: SessionStatusName; transcript: SessionHistoryEntry[] }
  >();

  /** The record for a session, created on first use. */
  function recordFor(sessionId: string): {
    status: SessionStatusName;
    transcript: SessionHistoryEntry[];
  } {
    let existing = sessionRecords.get(sessionId);
    if (!existing) {
      existing = { status: 'starting', transcript: [] };
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
    if (sessionId !== undefined) recordFor(sessionId).status = status;
  }

  /** Send an envelope on the daemon's channel, carrying the session id when present. */
  function sendForSession(source: Envelope, type: MessageType, payload: unknown): void {
    socket?.send(
      JSON.stringify(
        makeEnvelope({
          type,
          userId: source.user_id,
          deviceId: source.device_id,
          ...(source.session_id !== undefined ? { sessionId: source.session_id } : {}),
          payload,
        }),
      ),
    );
  }

  /**
   * The human-in-the-loop gate: forward a tool the agent wants to run to the browser as
   * `agent.permission_request` and return a promise that resolves with the human's decision. The agent
   * run is blocked on this promise until the matching `permission.decision` arrives.
   */
  function requestPermission(
    source: Envelope,
    request: PermissionRequest,
  ): Promise<PermissionDecision> {
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
      pendingPermissions.set(requestId, resolve);
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
   * Run one agent turn (the initial prompt or a follow-up) and stream its activity up, then end the
   * turn with `session.ended`. `resume` continues a prior agent conversation. The returned conversation
   * id is stored so the next `user.message` follow-up resumes this same session. One turn at a time per
   * session — a follow-up that races an in-flight turn is dropped (the UI also blocks it).
   */
  async function runTurn(
    envelope: Envelope,
    prompt: string,
    resume?: string,
    cwd?: string,
  ): Promise<void> {
    const sessionId = envelope.session_id;
    if (sessionId !== undefined && activeRuns.has(sessionId)) {
      log.warn({ deviceId: options.deviceId, sessionId }, 'daemon: turn already running; dropped');
      return;
    }
    if (sessionId !== undefined) activeRuns.add(sessionId);
    try {
      const result = await agentAdapter.run(prompt, {
        canUseTool: (request) => requestPermission(envelope, request),
        ...(cwd !== undefined ? { cwd } : {}),
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
        ...(resume !== undefined ? { resume } : {}),
      });
      if (sessionId !== undefined && result.sessionId !== undefined) {
        sdkSessions.set(sessionId, result.sessionId);
      }
      log.info({ deviceId: options.deviceId, sessionId }, 'daemon: turn ended');
      setStatus(sessionId, 'done');
      sendForSession(envelope, 'session.ended', { status: 'done' });
    } catch (err) {
      log.error({ err, sessionId }, 'daemon: turn failed');
      setStatus(sessionId, 'error');
      sendForSession(envelope, 'session.ended', {
        status: 'error',
        error: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      if (sessionId !== undefined) activeRuns.delete(sessionId);
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
    const launch = sessionLaunchPayloadSchema.safeParse(envelope.payload);
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
    record(envelope.session_id, { kind: 'user', text: launch.data.prompt });
    setStatus(envelope.session_id, 'running');
    // Echo the launch's correlation id so the launching browser can pair the relay-minted session id.
    sendForSession(
      envelope,
      'session.started',
      launch.data.clientRef !== undefined ? { clientRef: launch.data.clientRef } : {},
    );
    await runTurn(envelope, launch.data.prompt, undefined, cwd);
  }

  /** Run a follow-up turn for an existing session by resuming its agent conversation. */
  async function runFollowUp(envelope: Envelope): Promise<void> {
    const message = userMessagePayloadSchema.safeParse(envelope.payload);
    if (!message.success) {
      log.warn({ deviceId: options.deviceId }, 'daemon: dropped user.message with invalid payload');
      return;
    }
    const sessionId = envelope.session_id;
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
    await runTurn(envelope, message.data.text, resume, cwd);
  }

  function handleMessage(raw: Buffer, onReady: () => void): void {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(JSON.parse(raw.toString()));
    } catch (err) {
      log.warn({ err }, 'daemon: dropped invalid envelope');
      return;
    }

    switch (envelope.type) {
      case 'hello.ack': {
        log.info({ deviceId: options.deviceId }, 'daemon: registered with relay');
        onReady();
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
        const rec = sessionId !== undefined ? sessionRecords.get(sessionId) : undefined;
        const payload: SessionHistoryPayload = rec
          ? { status: rec.status, entries: rec.transcript }
          : { status: 'offline_paused', entries: [] };
        log.info(
          { deviceId: options.deviceId, sessionId, known: rec !== undefined },
          'daemon: session subscribe — backfilling history',
        );
        sendForSession(envelope, 'session.history', payload);
        return;
      }
      case 'permission.decision': {
        const decision = permissionDecisionPayloadSchema.safeParse(envelope.payload);
        if (!decision.success) {
          log.warn(
            { deviceId: options.deviceId },
            'daemon: dropped permission.decision with invalid payload',
          );
          return;
        }
        const resolve = pendingPermissions.get(decision.data.requestId);
        if (!resolve) {
          log.warn(
            { deviceId: options.deviceId, requestId: decision.data.requestId },
            'daemon: no pending permission for decision',
          );
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
        resolve(toPermissionDecision(decision.data));
        return;
      }
      default:
        log.debug({ type: envelope.type }, 'daemon: ignoring message');
    }
  }

  return {
    async start(): Promise<void> {
      const ws = new WebSocket(options.relayUrl);
      socket = ws;

      await new Promise<void>((resolve, reject) => {
        const onReady = (): void => resolve();
        ws.on('message', (raw: Buffer) => handleMessage(raw, onReady));
        ws.once('open', () => {
          ws.send(
            JSON.stringify(
              makeEnvelope({
                type: 'hello',
                userId: options.userId,
                deviceId: options.deviceId,
                payload: {
                  role: 'daemon',
                  ...(options.deviceToken !== undefined ? { token: options.deviceToken } : {}),
                },
              }),
            ),
          );
        });
        ws.once('error', reject);
      });
    },

    async stop(): Promise<void> {
      // Unblock any in-flight turns waiting on a human decision so their runs can finish instead of
      // hanging on a closed socket.
      for (const resolve of pendingPermissions.values()) {
        resolve({ behavior: 'deny', message: 'daemon stopping' });
      }
      pendingPermissions.clear();
      socket?.close();
      socket = null;
    },
  };
}
