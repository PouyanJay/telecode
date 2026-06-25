import {
  sessionStartedPayloadSchema,
  type Envelope,
  type PermissionDecisionPayload,
  type SessionControlAction,
  type SessionLaunchPayload,
} from '@telecode/protocol';
import { writable, type Readable } from 'svelte/store';

import { createRelayConnection, type ConnectionStatus, type RelayConnection } from './relay-client';
import { appendUserMessage, markDeciding } from './session';
import { foldSessionFrame, type SessionMap } from './sessions';

/**
 * The browser's single live link to the device's channel, shared across routes (dashboard + session
 * view) as a module singleton so SPA navigation never tears it down (reopen = reconnect, not restart).
 * It demultiplexes every inbound frame into per-session state by `session_id` and exposes the actions
 * the UI drives. Verification-gated actions (decide) show real pending state and confirm on the daemon's
 * round-trip; the launch optimism is only the local echo of the human's own prompt.
 */
export type ConnectionState = ConnectionStatus | 'idle';

export interface ConnectOptions {
  readonly relayUrl: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly channelToken: string;
  /** The watched device's X25519 public key (base64) for E2E; null/undefined keeps the channel cleartext. */
  readonly daemonPublicKey?: string | null;
}

interface PendingLaunch {
  /** Correlation id we put on the launch and the daemon echoes on `session.started`. */
  readonly clientRef: string;
  readonly resolve: (sessionId: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const LAUNCH_TIMEOUT_MS = 15_000;

const sessionMap = writable<SessionMap>(new Map());
const connState = writable<ConnectionState>('idle');

let connection: RelayConnection | null = null;
// Launches awaiting their relay-minted id, matched by the `clientRef` the daemon echoes on
// `session.started`. Matching by correlation id (not FIFO/arrival order) means a late frame for a
// timed-out launch can never mis-resolve a later one.
const pendingLaunches: PendingLaunch[] = [];

/** Live per-session state, keyed by session id. */
export const sessions: Readable<SessionMap> = { subscribe: sessionMap.subscribe };
/** The connection's honest state (idle / connecting / connected / error) for the top-bar indicator. */
export const connectionState: Readable<ConnectionState> = { subscribe: connState.subscribe };

function handleEvent(envelope: Envelope): void {
  sessionMap.update((map) => foldSessionFrame(map, envelope));
  // A started session resolves the launch carrying its correlation id (offline launches never start —
  // they reject on the launch timeout instead, since the relay can't read the opaque clientRef).
  if (envelope.type === 'session.started' && envelope.session_id !== undefined) {
    const started = sessionStartedPayloadSchema.safeParse(envelope.payload);
    const clientRef = started.success ? started.data.clientRef : undefined;
    if (clientRef !== undefined) {
      const index = pendingLaunches.findIndex((p) => p.clientRef === clientRef);
      if (index >= 0) pendingLaunches.splice(index, 1)[0]!.resolve(envelope.session_id);
    }
  }
}

/**
 * Open the shared connection (idempotent — the first authenticated route to mount wins). `createConn` is
 * a seam for tests to inject a fake connection; production uses the real {@link createRelayConnection}.
 */
export function connect(
  options: ConnectOptions,
  createConn: typeof createRelayConnection = createRelayConnection,
): void {
  if (connection) return;
  connState.set('connecting');
  connection = createConn({
    relayUrl: options.relayUrl,
    userId: options.userId,
    deviceId: options.deviceId,
    channelToken: options.channelToken,
    daemonPublicKey: options.daemonPublicKey,
    onStatus: (status) => connState.set(status),
    onEvent: handleEvent,
  });
}

/** Whether the shared connection has been opened (so a route doesn't re-fetch a channel token). */
export function isConnected(): boolean {
  return connection !== null;
}

let connecting: Promise<void> | null = null;

/**
 * Open the shared connection if it isn't already: mint a channel token (server-side, from the cookie)
 * and connect. Idempotent and browser-only — both the dashboard and the session view call it on mount;
 * a shared in-flight promise keeps a concurrent pair of callers from minting two tokens.
 */
export function ensureConnection(options: {
  relayUrl: string;
  userId: string;
  deviceId: string;
  daemonPublicKey?: string | null;
}): Promise<void> {
  if (connection) return Promise.resolve();
  connecting ??= (async () => {
    try {
      const res = await fetch('/api/channel-token');
      if (!res.ok) {
        connState.set('error');
        return;
      }
      const { channelToken } = (await res.json()) as { channelToken: string };
      connect({ ...options, channelToken });
    } catch {
      connState.set('error');
    }
  })().finally(() => {
    connecting = null;
  });
  return connecting;
}

/** Launch a session; resolves with the relay-minted id once the daemon reports it started. */
export function launch(payload: SessionLaunchPayload): Promise<string> {
  const conn = connection;
  if (!conn) return Promise.reject(new Error('Not connected to the relay.'));
  const clientRef = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    const pending: PendingLaunch = {
      clientRef,
      resolve: (sessionId) => {
        clearTimeout(pending.timer);
        resolve(sessionId);
      },
      reject: (error) => {
        clearTimeout(pending.timer);
        reject(error);
      },
      timer: setTimeout(() => {
        const index = pendingLaunches.indexOf(pending);
        if (index >= 0) pendingLaunches.splice(index, 1);
        reject(new Error('Launch timed out — is the device online?'));
      }, LAUNCH_TIMEOUT_MS),
    };
    pendingLaunches.push(pending);
    conn.launch({ ...payload, clientRef });
  });
}

/** Re-attach to an existing session on open; the daemon backfills its transcript via `session.history`. */
export function subscribe(sessionId: string): void {
  connection?.subscribe(sessionId);
}

/** Steer a session with a follow-up; echo the human's message locally (their own input, not the agent's). */
export function sendUserMessage(sessionId: string, text: string): void {
  const conn = connection;
  if (!conn) return; // Don't echo a message the daemon will never receive.
  sessionMap.update((map) => {
    const current = map.get(sessionId);
    if (!current) return map;
    const next = new Map(map);
    next.set(sessionId, { ...appendUserMessage(current, text), status: 'running' });
    return next;
  });
  conn.sendUserMessage(sessionId, text);
}

/** Send a permission verdict; mark it in-flight locally (confirmed on the daemon's next frame). */
export function decide(sessionId: string, decision: PermissionDecisionPayload): void {
  const conn = connection;
  // Guard before the optimistic mark: a dropped send would otherwise strand the gate spinning forever.
  if (!conn) return;
  sessionMap.update((map) => {
    const current = map.get(sessionId);
    if (!current) return map;
    const next = new Map(map);
    next.set(sessionId, markDeciding(current, decision.requestId, decision.behavior));
    return next;
  });
  conn.decide(sessionId, decision);
}

/** Send an operator control (end / interrupt / pause / resume); the daemon reports the resulting status. */
export function sendControl(sessionId: string, action: SessionControlAction): void {
  connection?.control(sessionId, action);
}

/** Close the connection and reject any in-flight launches (only on full teardown, e.g. sign-out). */
export function disconnect(): void {
  for (const pending of pendingLaunches.splice(0)) {
    pending.reject(new Error('Disconnected.'));
  }
  connection?.close();
  connection = null;
  connState.set('idle');
}
