import {
  devicePresencePayloadSchema,
  sessionChainedPayloadSchema,
  sessionStartedPayloadSchema,
  type AdoptSettings,
  type AdoptStatePayload,
  type Envelope,
  type HandoverAnswerPayload,
  type PermissionDecisionPayload,
  type QuestionAnswerPayload,
  type SessionControlAction,
  type SessionLaunchPayload,
} from '@telecode/protocol';
import { get, writable, type Readable } from 'svelte/store';

import { createRelayConnection, type ConnectionStatus, type RelayConnection } from './relay-client';
import {
  appendUserMessage,
  initialSessionState,
  linkHandoverChild,
  markAnswering,
  markDeciding,
  markHandoverSubmitting,
} from './session';
import { foldSessionFrame, markChannelOffline, type SessionMap } from './sessions';

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
  /** Mint a short-lived channel token; called on connect AND each reconnect so an expired one is renewed. */
  readonly getChannelToken: () => Promise<string>;
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
// The daemon's current adoption policy (Journey 3), updated from sealed `adopt.state` frames. Null until the
// Settings page requests it (or the daemon replies). Device-scoped, not per-session.
const adoptStateStore = writable<AdoptStatePayload | null>(null);

let connection: RelayConnection | null = null;
// Launches awaiting their relay-minted id, matched by the `clientRef` the daemon echoes on
// `session.started`. Matching by correlation id (not FIFO/arrival order) means a late frame for a
// timed-out launch can never mis-resolve a later one.
const pendingLaunches: PendingLaunch[] = [];

/** Live per-session state, keyed by session id. */
export const sessions: Readable<SessionMap> = { subscribe: sessionMap.subscribe };
/** The connection's honest state (idle / connecting / connected / error) for the top-bar indicator. */
export const connectionState: Readable<ConnectionState> = { subscribe: connState.subscribe };
/** The daemon's current adoption policy for the Settings UI; null until first received (Journey 3). */
export const adoptState: Readable<AdoptStatePayload | null> = {
  subscribe: adoptStateStore.subscribe,
};

function handleEvent(envelope: Envelope): void {
  // Device presence (Phase 4 Task 3) is channel-wide, not per-session: the daemon behind this channel
  // (dis)connected. Offline → pause every live session; online → resubscribe so the daemon backfills
  // and they resume. Handled here (not in foldSessionFrame, which routes by session_id).
  if (envelope.type === 'device.presence') {
    const presence = devicePresencePayloadSchema.safeParse(envelope.payload);
    if (!presence.success) return;
    if (presence.data.online) reattachSessions();
    else sessionMap.update((map) => markChannelOffline(map));
    return;
  }
  // A forked handover continuation was registered (Journey 4): it links the parent (adopted) session to the
  // child. This is a cross-session update (the frame carries the CHILD id + the PARENT id in its payload),
  // so it's handled here rather than in foldSessionFrame (which routes by a single session_id). The child's
  // own status/transcript still stream in via its `session.started` etc.
  if (envelope.type === 'session.chained' && envelope.session_id !== undefined) {
    const chained = sessionChainedPayloadSchema.safeParse(envelope.payload);
    if (!chained.success) return;
    const childId = envelope.session_id;
    const { parentSessionId } = chained.data;
    sessionMap.update((map) => {
      const next = new Map(map);
      // Record the parent link on the child (create its state if the chained frame beat session.started).
      const child = next.get(childId) ?? initialSessionState;
      next.set(childId, { ...child, parentSessionId });
      // Link the parent's handover to the child so its card can offer a "view continuation" link.
      const parent = next.get(parentSessionId);
      if (parent) next.set(parentSessionId, linkHandoverChild(parent, childId));
      return next;
    });
    return;
  }
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
    getChannelToken: options.getChannelToken,
    daemonPublicKey: options.daemonPublicKey,
    onStatus: (status) => connState.set(status),
    onEvent: handleEvent,
    onReconnect: reattachSessions,
    onAdoptState: (state) => adoptStateStore.set(state),
  });
}

/** Mint a fresh channel token from the web backend (the cookie → a short-lived signed token, BFF). */
async function fetchChannelToken(): Promise<string> {
  const res = await fetch('/api/channel-token');
  if (!res.ok) throw new Error('Could not mint a channel token.');
  // Validate at the boundary: an error/empty body must surface as a thrown error, not a silent
  // `undefined` token that the relay would later reject with a 4001 (an unexplained reconnect loop).
  const body = (await res.json()) as { channelToken?: unknown };
  if (typeof body.channelToken !== 'string' || body.channelToken === '') {
    throw new Error('The channel-token endpoint returned no token.');
  }
  return body.channelToken;
}

/**
 * After the connection transparently reconnects, re-subscribe every session this browser knows about so
 * the daemon backfills its current transcript (reopen = reconnect — architecture invariant #7). Terminal
 * sessions backfill harmlessly; active ones resume streaming, with no page reload.
 */
function reattachSessions(): void {
  const conn = connection;
  if (!conn) return;
  for (const id of get(sessionMap).keys()) conn.subscribe(id);
}

/** Whether the shared connection has been opened (so a route doesn't re-fetch a channel token). */
export function isConnected(): boolean {
  return connection !== null;
}

/**
 * Open the shared connection if it isn't already, minting channel tokens on demand — on the first connect
 * and on every reconnect, so a token that lapsed during a sleep is renewed (Phase 4 Task 4). Idempotent
 * and browser-only — both the dashboard and the session view call it on mount; `connect`'s own guard
 * makes concurrent callers safe.
 */
export function ensureConnection(options: {
  relayUrl: string;
  userId: string;
  deviceId: string;
  daemonPublicKey?: string | null;
}): Promise<void> {
  if (!connection) connect({ ...options, getChannelToken: fetchChannelToken });
  return Promise.resolve();
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

/**
 * Send the human's answer to an adopted session's question (Journey 2); mark it in-flight locally
 * (confirmed on the daemon's next frame, like {@link decide}). The daemon relays it to the model as
 * deny-feedback — best-effort (AD-4).
 */
export function answer(sessionId: string, payload: QuestionAnswerPayload): void {
  const conn = connection;
  // Guard before the optimistic mark: a dropped send would otherwise strand the picker spinning forever.
  if (!conn) return;
  sessionMap.update((map) => {
    const current = map.get(sessionId);
    if (!current) return map;
    const next = new Map(map);
    next.set(sessionId, markAnswering(current, payload.requestId, payload.answers));
    return next;
  });
  conn.answer(sessionId, payload);
}

/**
 * Take over an adopted session's free-form question (Journey 4); mark the offer in-flight locally
 * (confirmed on the daemon's next frame, like {@link answer}). The daemon forks-and-resumes the adopted
 * conversation with this answer as its next turn — migrating it to a telecode-owned continuation.
 */
export function answerHandover(sessionId: string, payload: HandoverAnswerPayload): void {
  const conn = connection;
  // Guard before the optimistic mark: a dropped send would otherwise strand the card spinning forever.
  if (!conn) return;
  sessionMap.update((map) => {
    const current = map.get(sessionId);
    if (!current) return map;
    const next = new Map(map);
    next.set(sessionId, markHandoverSubmitting(current, payload.requestId, payload.answerText));
    return next;
  });
  conn.answerHandover(sessionId, payload);
}

/** Send an operator control (interrupt / end); the daemon reports the resulting status. */
export function sendControl(sessionId: string, action: SessionControlAction): void {
  connection?.control(sessionId, action);
}

/** Ask the daemon for its current adoption policy (Journey 3); the reply lands on {@link adoptState}. */
export function requestAdoptConfig(): void {
  connection?.sendAdoptConfig();
}

/** Update the daemon's adoption policy (sealed); the daemon persists it and echoes {@link adoptState}. */
export function setAdoptConfig(settings: AdoptSettings): void {
  connection?.sendAdoptConfig(settings);
}

/** Close the connection and reject any in-flight launches (only on full teardown, e.g. sign-out). */
export function disconnect(): void {
  for (const pending of pendingLaunches.splice(0)) {
    pending.reject(new Error('Disconnected.'));
  }
  connection?.close();
  connection = null;
  connState.set('idle');
  // Full teardown (sign-out): drop watched-session state. A later reconnect re-fetches the list from the
  // registry and backfills transcripts, so nothing stale should linger across a disconnect.
  sessionMap.set(new Map());
  adoptStateStore.set(null);
}
