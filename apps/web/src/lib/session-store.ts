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
import { derived, get, writable, type Readable } from 'svelte/store';

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
 * The browser's live links to its paired devices — ONE relay connection per device (ux Phase 5),
 * shared across routes as a module singleton so SPA navigation never tears them down (reopen =
 * reconnect, not restart). Every device's frames demultiplex into the one per-session map by
 * `session_id`; a routing map (`sessionId → deviceId`, fed by registry seeds and the envelopes'
 * own `device_id`) sends each action out on the session's OWN device's channel. The single-device
 * store this replaces was the N=1 degenerate case.
 */
export type ConnectionState = ConnectionStatus | 'idle';

/** A paired device the pool should hold a channel to (id + its daemon's E2E public key). */
export interface PoolDevice {
  readonly id: string;
  /** The device daemon's X25519 public key (base64); null keeps that channel cleartext. */
  readonly publicKey: string | null;
}

/** One device channel's live state: the browser↔relay socket and the daemon's presence on it. */
export interface DeviceChannelState {
  readonly connection: ConnectionState;
  /** Whether the device's DAEMON is on the channel (`device.presence`); null = no frame yet. */
  readonly daemonOnline: boolean | null;
}

export interface ConnectOptions {
  readonly relayUrl: string;
  readonly userId: string;
  /** Mint a short-lived channel token; called on connect AND each reconnect so an expired one is renewed. */
  readonly getChannelToken: () => Promise<string>;
}

interface PendingLaunch {
  /** Correlation id we put on the launch and the daemon echoes on `session.started`. */
  readonly clientRef: string;
  /** The device the launch was sent to — routes the minted session before its first frame lands. */
  readonly deviceId: string;
  readonly resolve: (sessionId: string) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const LAUNCH_TIMEOUT_MS = 15_000;

const sessionMap = writable<SessionMap>(new Map());
// Per-device channel state (socket status + daemon presence), keyed by device id.
const deviceChannelMap = writable<ReadonlyMap<string, DeviceChannelState>>(new Map());
// Which device each session runs on — the send-routing truth. Fed by registry seeds (cold loads)
// and by every inbound frame's `device_id` (authoritative for live sessions).
const sessionDeviceMap = writable<ReadonlyMap<string, string>>(new Map());
// Each device daemon's adoption policy (Journey 3, per-device since ux Phase 5), keyed by device
// id and updated from that channel's sealed `adopt.state` frames. A device is absent until the
// Settings page requests its policy (or its daemon replies).
const adoptStatesMap = writable<ReadonlyMap<string, AdoptStatePayload>>(new Map());

const connections = new Map<string, RelayConnection>();
// Launches awaiting their relay-minted id, matched by the `clientRef` the daemon echoes on
// `session.started`. Matching by correlation id (not FIFO/arrival order) means a late frame for a
// timed-out launch can never mis-resolve a later one.
const pendingLaunches: PendingLaunch[] = [];

/** Live per-session state, keyed by session id. */
export const sessions: Readable<SessionMap> = { subscribe: sessionMap.subscribe };
/** Per-device channel state (socket + daemon presence) for presence-aware surfaces. */
export const deviceChannels: Readable<ReadonlyMap<string, DeviceChannelState>> = {
  subscribe: deviceChannelMap.subscribe,
};
/** Which device each session runs on (routing metadata mirrored for the UI). */
export const sessionDevices: Readable<ReadonlyMap<string, string>> = {
  subscribe: sessionDeviceMap.subscribe,
};

/**
 * The aggregate browser↔relay link state for the system bar. Every pooled socket dials the same
 * relay, so one healthy socket proves the relay is reachable: any connected → connected; else any
 * still trying → connecting; else any failed → error; an empty pool is idle.
 */
export const connectionState: Readable<ConnectionState> = derived(deviceChannelMap, (channels) => {
  let sawConnecting = false;
  let sawError = false;
  for (const channel of channels.values()) {
    if (channel.connection === 'connected') return 'connected';
    if (channel.connection === 'connecting') sawConnecting = true;
    if (channel.connection === 'error') sawError = true;
  }
  return sawConnecting ? 'connecting' : sawError ? 'error' : 'idle';
});

/** Each device daemon's adoption policy for the Settings UI, keyed by device id (Journey 3 / ux Phase 5). */
export const adoptStates: Readable<ReadonlyMap<string, AdoptStatePayload>> = {
  subscribe: adoptStatesMap.subscribe,
};

function updateChannel(deviceId: string, patch: Partial<DeviceChannelState>): void {
  deviceChannelMap.update((channels) => {
    const next = new Map(channels);
    const current = next.get(deviceId) ?? { connection: 'idle', daemonOnline: null };
    next.set(deviceId, { ...current, ...patch });
    return next;
  });
}

/** Record which device a session runs on (from a frame's envelope or a registry seed). */
function routeSession(sessionId: string, deviceId: string): void {
  sessionDeviceMap.update((routes) => {
    if (routes.get(sessionId) === deviceId) return routes;
    const next = new Map(routes);
    next.set(sessionId, deviceId);
    return next;
  });
}

/** The session ids routed to one device — the scope of its presence/pause events. */
function sessionIdsOf(deviceId: string): Set<string> {
  const ids = new Set<string>();
  for (const [sessionId, routedDevice] of get(sessionDeviceMap)) {
    if (routedDevice === deviceId) ids.add(sessionId);
  }
  return ids;
}

/**
 * The connection a session's actions must go out on: its routed device's. With a single pooled
 * connection the sole channel is the honest fallback (the pre-pool behavior); with several, an
 * unrouted send is dropped rather than guessed — a decision must never reach the wrong daemon
 * (AD-2: no fan-out; routing is seeded from the registry, so this is a registry-outage edge).
 */
function connectionFor(sessionId: string): RelayConnection | null {
  const deviceId = get(sessionDeviceMap).get(sessionId);
  if (deviceId !== undefined) return connections.get(deviceId) ?? null;
  if (connections.size === 1) {
    const sole = connections.values().next().value;
    return sole ?? null;
  }
  return null;
}

function handleEvent(deviceId: string, envelope: Envelope): void {
  // Device presence (Phase 4 Task 3) is channel-wide, not per-session: the daemon behind THIS
  // device's channel (dis)connected. Offline → pause that device's live sessions; online →
  // resubscribe them so the daemon backfills and they resume.
  if (envelope.type === 'device.presence') {
    const presence = devicePresencePayloadSchema.safeParse(envelope.payload);
    if (!presence.success) return;
    updateChannel(deviceId, { daemonOnline: presence.data.online });
    if (presence.data.online) reattachSessions(deviceId);
    else sessionMap.update((map) => markChannelOffline(map, pauseScopeOf(deviceId)));
    return;
  }
  // Any session frame names its device — record the route so actions go back out the same channel.
  if (envelope.session_id !== undefined) {
    routeSession(envelope.session_id, envelope.device_id);
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
 * The sessions a device's offline event pauses: the ones routed to it — plus, on a single-channel
 * pool, the unrouted rest (the degenerate pre-pool behavior, where the sole channel owned every
 * session by definition).
 */
function pauseScopeOf(deviceId: string): Set<string> {
  const ids = sessionIdsOf(deviceId);
  if (connections.size === 1) {
    const routes = get(sessionDeviceMap);
    for (const sessionId of get(sessionMap).keys()) {
      if (!routes.has(sessionId)) ids.add(sessionId);
    }
  }
  return ids;
}

/**
 * Open/refresh the pool: one connection per paired device, idempotently — already-pooled devices
 * are reused, new ones dial, and a device no longer in the fleet (revoked) has its connection
 * closed and channel state dropped. `createConn` is the test seam; production uses the real
 * {@link createRelayConnection}.
 */
export function connectDevices(
  devices: readonly PoolDevice[],
  options: ConnectOptions,
  createConn: typeof createRelayConnection = createRelayConnection,
): void {
  const wanted = new Set(devices.map((device) => device.id));
  // Close channels for devices that left the fleet (revoked/unpaired).
  for (const [deviceId, connection] of connections) {
    if (!wanted.has(deviceId)) {
      connection.close();
      connections.delete(deviceId);
      deviceChannelMap.update((channels) => {
        const next = new Map(channels);
        next.delete(deviceId);
        return next;
      });
      adoptStatesMap.update((states) => {
        if (!states.has(deviceId)) return states;
        const next = new Map(states);
        next.delete(deviceId);
        return next;
      });
    }
  }
  for (const device of devices) {
    if (connections.has(device.id)) continue;
    updateChannel(device.id, { connection: 'connecting', daemonOnline: null });
    const connection = createConn({
      relayUrl: options.relayUrl,
      userId: options.userId,
      deviceId: device.id,
      getChannelToken: options.getChannelToken,
      daemonPublicKey: device.publicKey,
      onStatus: (status) => updateChannel(device.id, { connection: status }),
      onEvent: (envelope) => handleEvent(device.id, envelope),
      onReconnect: () => reattachSessions(device.id),
      onAdoptState: (state) =>
        adoptStatesMap.update((states) => new Map(states).set(device.id, state)),
    });
    connections.set(device.id, connection);
  }
}

/**
 * Single-device entry kept as the focused test seam (the pool of one): the existing store tests
 * drive every session action through it, which keeps the N=1 degenerate case pinned.
 */
export function connect(
  options: {
    relayUrl: string;
    userId: string;
    deviceId: string;
    getChannelToken: () => Promise<string>;
    daemonPublicKey?: string | null;
  },
  createConn: typeof createRelayConnection = createRelayConnection,
): void {
  connectDevices(
    [{ id: options.deviceId, publicKey: options.daemonPublicKey ?? null }],
    {
      relayUrl: options.relayUrl,
      userId: options.userId,
      getChannelToken: options.getChannelToken,
    },
    createConn,
  );
}

// One mint serves every channel dialing in the same wave: the token is per-USER (60s TTL), so N
// per-device sockets opening together must not issue N HTTP mints (that needlessly eats the
// relay's per-IP budget). Far below the TTL, so a shared token is always still fresh; a reconnect
// after the window mints anew, keeping the expiry-renewal behavior (Phase 4 Task 4).
const CHANNEL_TOKEN_SHARE_MS = 5_000;
let mintedToken: { readonly token: Promise<string>; readonly at: number } | null = null;

/** Mint a fresh channel token from the web backend (the cookie → a short-lived signed token, BFF). */
function fetchChannelToken(): Promise<string> {
  const now = Date.now();
  if (mintedToken && now - mintedToken.at < CHANNEL_TOKEN_SHARE_MS) {
    return mintedToken.token;
  }
  const token = (async (): Promise<string> => {
    const res = await fetch('/api/channel-token');
    if (!res.ok) throw new Error('Could not mint a channel token.');
    // Validate at the boundary: an error/empty body must surface as a thrown error, not a silent
    // `undefined` token that the relay would later reject with a 4001 (an unexplained reconnect loop).
    const body = (await res.json()) as { channelToken?: unknown };
    if (typeof body.channelToken !== 'string' || body.channelToken === '') {
      throw new Error('The channel-token endpoint returned no token.');
    }
    return body.channelToken;
  })();
  mintedToken = { token, at: now };
  // A failed mint must not poison the share window — the next caller tries again immediately.
  token.catch(() => {
    mintedToken = null;
  });
  return token;
}

/**
 * After a device's connection transparently reconnects — or its daemon comes back online — re-subscribe
 * that device's sessions so the daemon backfills their transcripts (reopen = reconnect, invariant #7).
 * Terminal sessions backfill harmlessly; active ones resume streaming, with no page reload.
 */
function reattachSessions(deviceId: string): void {
  const conn = connections.get(deviceId);
  if (!conn) return;
  const scope = pauseScopeOf(deviceId);
  for (const id of get(sessionMap).keys()) {
    if (scope.has(id)) conn.subscribe(id);
  }
}

/**
 * Seed session→device routing from the persisted registry (the layout's SSR data), so a cold
 * page's subscribes route correctly before any live frame has named a device. Live frames stay
 * authoritative — a seed never overwrites an existing route... it IS the same truth (the registry
 * row's deviceId), just earlier.
 */
export function seedSessionDevices(
  rows: readonly { readonly id: string; readonly deviceId: string }[],
): void {
  sessionDeviceMap.update((routes) => {
    let next: Map<string, string> | null = null;
    for (const row of rows) {
      if (routes.get(row.id) === row.deviceId) continue;
      next = next ?? new Map(routes);
      next.set(row.id, row.deviceId);
    }
    return next ?? routes;
  });
}

/**
 * Open/refresh the pooled connections if needed, minting channel tokens on demand — on the first
 * connect and on every reconnect, so a token that lapsed during a sleep is renewed (Phase 4 Task 4).
 * Idempotent and browser-only — the layout calls it whenever the device list changes.
 */
export function ensureConnections(options: {
  relayUrl: string;
  userId: string;
  devices: readonly PoolDevice[];
}): void {
  connectDevices(options.devices, {
    relayUrl: options.relayUrl,
    userId: options.userId,
    getChannelToken: fetchChannelToken,
  });
}

/**
 * Launch a session on one device; resolves with the relay-minted id once the daemon reports it
 * started. The target device is explicit — with a fleet there is no "the" device to default to.
 */
export function launch(payload: SessionLaunchPayload, deviceId?: string): Promise<string> {
  const targetId = deviceId ?? (connections.size === 1 ? [...connections.keys()][0] : undefined);
  const conn = targetId !== undefined ? connections.get(targetId) : undefined;
  if (!conn || targetId === undefined) {
    return Promise.reject(new Error('Not connected to the relay.'));
  }
  const clientRef = crypto.randomUUID();
  return new Promise<string>((resolve, reject) => {
    const pending: PendingLaunch = {
      clientRef,
      deviceId: targetId,
      resolve: (sessionId) => {
        clearTimeout(pending.timer);
        // Route before resolving: the caller navigates to the session view, which subscribes.
        routeSession(sessionId, targetId);
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
  connectionFor(sessionId)?.subscribe(sessionId);
}

/** Steer a session with a follow-up; echo the human's message locally (their own input, not the agent's). */
export function sendUserMessage(sessionId: string, text: string): void {
  const conn = connectionFor(sessionId);
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
  const conn = connectionFor(sessionId);
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
  const conn = connectionFor(sessionId);
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
  const conn = connectionFor(sessionId);
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
  connectionFor(sessionId)?.control(sessionId, action);
}

/** Ask ONE device's daemon for its adoption policy (Journey 3); the reply lands on {@link adoptStates}. */
export function requestAdoptConfig(deviceId: string): void {
  connections.get(deviceId)?.sendAdoptConfig();
}

/** Update ONE device's adoption policy (sealed); its daemon persists it and echoes {@link adoptStates}. */
export function setAdoptConfig(deviceId: string, settings: AdoptSettings): void {
  connections.get(deviceId)?.sendAdoptConfig(settings);
}

/** Close every pooled connection and reject in-flight launches (only on full teardown, e.g. sign-out). */
export function disconnect(): void {
  for (const pending of pendingLaunches.splice(0)) {
    pending.reject(new Error('Disconnected.'));
  }
  for (const connection of connections.values()) connection.close();
  connections.clear();
  deviceChannelMap.set(new Map());
  sessionDeviceMap.set(new Map());
  // Full teardown (sign-out): drop watched-session state. A later reconnect re-fetches the list from the
  // registry and backfills transcripts, so nothing stale should linger across a disconnect.
  sessionMap.set(new Map());
  adoptStatesMap.set(new Map());
}
