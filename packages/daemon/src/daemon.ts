import { randomUUID } from 'node:crypto';

import { pino, type Logger } from 'pino';
import WebSocket from 'ws';

import {
  echoPayloadSchema,
  makeEnvelope,
  parseEnvelope,
  permissionDecisionPayloadSchema,
  sessionLaunchPayloadSchema,
  userMessagePayloadSchema,
  type Envelope,
  type MessageType,
  type PermissionDecisionPayload,
} from '@telecode/protocol';

import {
  type AgentAdapter,
  type PermissionDecision,
  type PermissionRequest,
} from './agent-adapter';
import { createClaudeAgentAdapter } from './claude-agent-adapter';

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
  let socket: WebSocket | null = null;

  // Tool requests the agent is blocked on, keyed by the correlation id we send to the browser; each is
  // resolved when its matching `permission.decision` returns. Single-session in Phase 1, but keyed so it
  // stays correct as sessions multiply.
  const pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  // The agent conversation id per telecode session, so a `user.message` follow-up resumes the same chat.
  const sdkSessions = new Map<string, string>();
  // Telecode sessions with a turn in flight (one turn at a time per session).
  const activeRuns = new Set<string>();

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
    return new Promise<PermissionDecision>((resolve) => {
      pendingPermissions.set(requestId, resolve);
      log.info(
        {
          device: options.deviceId,
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
  async function runTurn(envelope: Envelope, prompt: string, resume?: string): Promise<void> {
    const sid = envelope.session_id;
    if (sid !== undefined && activeRuns.has(sid)) {
      log.warn(
        { device: options.deviceId, sessionId: sid },
        'daemon: turn already running; dropped',
      );
      return;
    }
    if (sid !== undefined) activeRuns.add(sid);
    try {
      const result = await agentAdapter.run(prompt, {
        // Every tool the agent wants to run is gated through the browser (the human-in-the-loop hook).
        canUseTool: (request) => requestPermission(envelope, request),
        onEvent: (event) => {
          if (event.type === 'message') {
            sendForSession(envelope, 'agent.message', { text: event.text });
          } else {
            sendForSession(envelope, 'agent.tool_use', {
              toolName: event.toolName,
              input: event.input,
            });
          }
        },
        ...(resume !== undefined ? { resume } : {}),
      });
      if (sid !== undefined && result.sessionId !== undefined) {
        sdkSessions.set(sid, result.sessionId);
      }
      log.info({ device: options.deviceId, sessionId: sid }, 'daemon: turn ended');
      sendForSession(envelope, 'session.ended', { status: 'done' });
    } catch (err) {
      log.error({ err, sessionId: sid }, 'daemon: turn failed');
      sendForSession(envelope, 'session.ended', {
        status: 'error',
        error: err instanceof Error ? err.message : 'unknown error',
      });
    } finally {
      if (sid !== undefined) activeRuns.delete(sid);
    }
  }

  /** Launch a new session: announce it started, then run the first turn. */
  async function runSession(envelope: Envelope): Promise<void> {
    const launch = sessionLaunchPayloadSchema.safeParse(envelope.payload);
    if (!launch.success) {
      // The relay already minted a `starting` row; fail it cleanly so it can't stick at `starting`.
      log.warn(
        { device: options.deviceId },
        'daemon: rejected session.launch with invalid payload',
      );
      sendForSession(envelope, 'session.ended', {
        status: 'error',
        error: 'invalid launch payload',
      });
      return;
    }
    log.info(
      { device: options.deviceId, sessionId: envelope.session_id },
      'daemon: session launch received',
    );
    sendForSession(envelope, 'session.started', {});
    await runTurn(envelope, launch.data.prompt);
  }

  /** Run a follow-up turn for an existing session by resuming its agent conversation. */
  async function runFollowUp(envelope: Envelope): Promise<void> {
    const message = userMessagePayloadSchema.safeParse(envelope.payload);
    if (!message.success) {
      log.warn({ device: options.deviceId }, 'daemon: dropped user.message with invalid payload');
      return;
    }
    const sid = envelope.session_id;
    const resume = sid !== undefined ? sdkSessions.get(sid) : undefined;
    if (resume === undefined) {
      log.warn(
        { device: options.deviceId, sessionId: sid },
        'daemon: no agent conversation to resume for follow-up',
      );
      return;
    }
    log.info({ device: options.deviceId, sessionId: sid }, 'daemon: follow-up received');
    await runTurn(envelope, message.data.text, resume);
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
        log.info({ device: options.deviceId }, 'daemon: registered with relay');
        onReady();
        return;
      }
      case 'echo': {
        const echo = echoPayloadSchema.safeParse(envelope.payload);
        if (!echo.success) {
          log.warn({ device: options.deviceId }, 'daemon: dropped echo with invalid payload');
          return;
        }
        const { text } = echo.data;
        log.info({ device: options.deviceId, text }, 'daemon: echo received');
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
      case 'permission.decision': {
        const decision = permissionDecisionPayloadSchema.safeParse(envelope.payload);
        if (!decision.success) {
          log.warn(
            { device: options.deviceId },
            'daemon: dropped permission.decision with invalid payload',
          );
          return;
        }
        const resolve = pendingPermissions.get(decision.data.requestId);
        if (!resolve) {
          log.warn(
            { device: options.deviceId, requestId: decision.data.requestId },
            'daemon: no pending permission for decision',
          );
          return;
        }
        pendingPermissions.delete(decision.data.requestId);
        log.info(
          {
            device: options.deviceId,
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
      socket?.close();
      socket = null;
    },
  };
}
