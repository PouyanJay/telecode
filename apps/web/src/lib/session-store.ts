import {
  devicePresencePayloadSchema,
  relayErrorPayloadSchema,
  sessionChainedPayloadSchema,
  sessionStartedPayloadSchema,
  type AdoptSettings,
  type AdoptStatePayload,
  type RepoBranchesStatePayload,
  type Envelope,
  type HandoverAnswerPayload,
  type PermissionDecisionPayload,
  type QuestionAnswerPayload,
  sessionBranchStatePayloadSchema,
  type BranchSwitchFailureCode,
  type SessionControlAction,
  type SessionLaunchPayload,
  type SessionRenameBody,
  type WorkspaceReapFailureCode,
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
import {
  defaultContentKeyStore,
  openSealedWithStoredKey,
  type ContentKeyStore,
} from './content-key-store';
import {
  applyMetaFrame,
  seedRegistryMetas,
  seedRegistryMetasAsync,
  type SealedMetaDecryptor,
  type SessionMetaMap,
} from './session-meta';
import { applyChangesFrame, type SessionChangesMap } from './session-changes';
import {
  applyTitleFrame,
  overlayMissingTitles,
  seedRegistryTitles,
  seedRegistryTitlesAsync,
  type SessionTitleMap,
} from './session-title';
import type { SessionMetaPayload } from '@telecode/protocol';
import type { RegistrySessionRow } from './session-groups';
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
const repoBranchesMap = writable<ReadonlyMap<string, RepoBranchesStatePayload>>(new Map());
// Session-scoped branch listings (branch-actions T4), keyed by session id: the rail's Switch
// picker and the fork drawer ask per session; the sealed reply echoes the id.
const sessionBranchesMap = writable<ReadonlyMap<string, RepoBranchesStatePayload>>(new Map());
// Decrypted session metadata (ux Phase 6), keyed by session id: live `session.meta` frames merged
// over the registry's persisted blobs (seeded on load). Titles here beat every other title source.
const sessionMetaMap = writable<SessionMetaMap>(new Map());
// Decrypted branch-diff summaries (branch-actions Phase C), keyed by session id: latest-wins
// `session.changes` snapshots feeding the rail's CHANGES panel.
const sessionChangesMap = writable<SessionChangesMap>(new Map());
// The user's rename overrides (ux Phase 6 T6), keyed by session id: live `session.title` frames over
// the registry's persisted `sealed_title` blobs. Kept SEPARATE from the meta map so the override always
// wins on display — a later derived title from the daemon can never clobber a rename.
const sessionTitleOverrideMap = writable<SessionTitleMap>(new Map());

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
/** Decrypted session metadata (ux Phase 6) for titles and session-view context. */
export const sessionMetas: Readable<SessionMetaMap> = { subscribe: sessionMetaMap.subscribe };
/** Decrypted branch-diff summaries (Phase C) for the session rail's CHANGES panel. */
export const sessionChanges: Readable<SessionChangesMap> = {
  subscribe: sessionChangesMap.subscribe,
};
/** The user's rename overrides (ux Phase 6 T6) — the highest-precedence title source (override-wins). */
export const sessionTitleOverrides: Readable<SessionTitleMap> = {
  subscribe: sessionTitleOverrideMap.subscribe,
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

/** Per-device default-repo branches (sealed `repo.branches.state`) for the launch drawer (Phase B). */
export const repoBranches: Readable<ReadonlyMap<string, RepoBranchesStatePayload>> = {
  subscribe: repoBranchesMap.subscribe,
};

/** Per-session repo branches (T4) for the rail's Switch picker and the fork drawer's base list. */
export const sessionBranches: Readable<ReadonlyMap<string, RepoBranchesStatePayload>> = {
  subscribe: sessionBranchesMap.subscribe,
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
 * The device a session's actions must go out on: its route if known, else the sole pooled connection
 * (the pre-pool behavior); with several devices, an unrouted session resolves to nothing rather than a
 * guess — an action must never reach the wrong daemon (AD-2: no fan-out; routing is seeded from the
 * registry, so this is a registry-outage edge).
 */
function routedDeviceId(sessionId: string): string | undefined {
  return (
    get(sessionDeviceMap).get(sessionId) ??
    (connections.size === 1 ? [...connections.keys()][0] : undefined)
  );
}

/** The connection a session's actions go out on (see {@link routedDeviceId}), or null. */
function connectionFor(sessionId: string): RelayConnection | null {
  const deviceId = routedDeviceId(sessionId);
  return deviceId !== undefined ? (connections.get(deviceId) ?? null) : null;
}

/**
 * One inbound frame from one device's channel, dispatched by concern. Routing trusts `deviceId` —
 * the identity of the socket the frame physically arrived on — never the envelope's own
 * `device_id` claim (they agree by relay construction; the socket is the deeper truth).
 */
function handleEvent(deviceId: string, envelope: Envelope): void {
  if (envelope.type === 'device.presence') {
    handleDevicePresence(deviceId, envelope);
    return;
  }
  // Any session frame names its device — record the route so actions go back out the same channel.
  if (envelope.session_id !== undefined) {
    routeSession(envelope.session_id, deviceId);
  }
  if (envelope.type === 'session.chained' && envelope.session_id !== undefined) {
    linkChainedSessions(envelope.session_id, envelope);
    return;
  }
  if (envelope.type === 'session.meta') {
    // Identity metadata, not transcript: it feeds the meta map (titles), never the session state.
    sessionMetaMap.update((map) => applyMetaFrame(map, envelope));
    return;
  }
  if (envelope.type === 'session.title') {
    // The user's rename override (ux Phase 6 T6): its own map, kept apart from meta so it wins on display.
    sessionTitleOverrideMap.update((map) => applyTitleFrame(map, envelope));
    return;
  }
  if (envelope.type === 'session.changes') {
    // Branch-diff summary (Phase C): its own map, not transcript — the rail reads it directly.
    sessionChangesMap.update((map) => applyChangesFrame(map, envelope));
    return;
  }
  if (envelope.type === 'session.branch.state') {
    settleBranchSwitchFrame(envelope);
    return;
  }
  if (envelope.type === 'relay.error' && settleOfflineDeviceAsk(envelope)) {
    return;
  }
  sessionMap.update((map) => foldSessionFrame(map, envelope));
  resolvePendingLaunch(envelope);
}

/**
 * The switch verdict (Phase C T4): settles the asking control; the branch row itself follows the
 * daemon's `session.meta` re-emit, so this never touches the meta map.
 */
function settleBranchSwitchFrame(envelope: Envelope): void {
  if (envelope.session_id === undefined) return;
  const parsed = sessionBranchStatePayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return;
  switchAsks.settle(
    envelope.session_id,
    parsed.data.ok
      ? { ok: true, branch: parsed.data.branch }
      : { ok: false, reason: parsed.data.code },
  );
}

/**
 * A device-ask that reached an offline device (Phase C): settle the waiting flow honestly instead
 * of letting it time out. Returns whether the error was consumed — every other `relay.error`
 * keeps flowing into the session fold (gate un-spin).
 */
function settleOfflineDeviceAsk(envelope: Envelope): boolean {
  if (envelope.session_id === undefined) return false;
  const parsed = relayErrorPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) return false;
  if (parsed.data.regarding === 'workspace.reap') {
    reapAsks.settle(envelope.session_id, { ok: false, reason: 'daemon-offline' });
    return true;
  }
  if (parsed.data.regarding === 'session.branch.switch') {
    switchAsks.settle(envelope.session_id, { ok: false, reason: 'daemon-offline' });
    return true;
  }
  return false;
}

/**
 * Device presence (Phase 4 Task 3) is channel-wide, not per-session: the daemon behind THIS
 * device's channel (dis)connected. Offline → pause that device's live sessions; online →
 * resubscribe them so the daemon backfills and they resume.
 */
function handleDevicePresence(deviceId: string, envelope: Envelope): void {
  const presence = devicePresencePayloadSchema.safeParse(envelope.payload);
  if (!presence.success) return;
  updateChannel(deviceId, { daemonOnline: presence.data.online });
  if (presence.data.online) reattachSessions(deviceId);
  else sessionMap.update((map) => markChannelOffline(map, pauseScopeOf(deviceId)));
}

/**
 * A forked handover continuation was registered (Journey 4): link the parent (adopted) session to
 * the child. This is a cross-session update (the frame carries the CHILD id + the PARENT id in its
 * payload), so it's handled here rather than in foldSessionFrame (which routes by a single
 * session_id). The child's own status/transcript still stream in via its `session.started` etc.
 */
function linkChainedSessions(childId: string, envelope: Envelope): void {
  const chained = sessionChainedPayloadSchema.safeParse(envelope.payload);
  if (!chained.success) return;
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
}

/**
 * A started session resolves the launch carrying its correlation id (offline launches never start —
 * they reject on the launch timeout instead, since the relay can't read the opaque clientRef).
 */
function resolvePendingLaunch(envelope: Envelope): void {
  if (envelope.type !== 'session.started' || envelope.session_id === undefined) return;
  const started = sessionStartedPayloadSchema.safeParse(envelope.payload);
  const clientRef = started.success ? started.data.clientRef : undefined;
  if (clientRef === undefined) return;
  const index = pendingLaunches.findIndex((p) => p.clientRef === clientRef);
  if (index >= 0) pendingLaunches.splice(index, 1)[0]!.resolve(envelope.session_id);
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
 * closed and per-device state dropped. `createConn` is the test seam; production uses the real
 * {@link createRelayConnection}.
 */
export function connectDevices(
  devices: readonly PoolDevice[],
  options: ConnectOptions,
  createConn: typeof createRelayConnection = createRelayConnection,
): void {
  closeChannelsNotIn(new Set(devices.map((device) => device.id)));
  for (const device of devices) {
    if (!connections.has(device.id)) dialDeviceChannel(device, options, createConn);
  }
}

/** Close + forget the channels of devices that left the fleet (revoked/unpaired). */
function closeChannelsNotIn(wanted: ReadonlySet<string>): void {
  for (const [deviceId, connection] of connections) {
    if (wanted.has(deviceId)) continue;
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
    repoBranchesMap.update((states) => {
      if (!states.has(deviceId)) return states;
      const next = new Map(states);
      next.delete(deviceId);
      return next;
    });
  }
}

/** Dial one device's channel and wire its callbacks into the per-device stores. */
function dialDeviceChannel(
  device: PoolDevice,
  options: ConnectOptions,
  createConn: typeof createRelayConnection,
): void {
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
    onRepoBranches: (state) => {
      // A session-scoped answer (echoed id, T4) keys by session; the Phase B default form by device.
      if (state.sessionId !== undefined) {
        const sessionId = state.sessionId;
        sessionBranchesMap.update((states) => new Map(states).set(sessionId, state));
      } else {
        repoBranchesMap.update((states) => new Map(states).set(device.id, state));
      }
    },
    onWorkspaceReap: (state) =>
      reapAsks.settle(state.sessionId, state.ok ? { ok: true } : { ok: false, reason: state.code }),
  });
  connections.set(device.id, connection);
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
  // Identity-guarded: a slow mint rejecting AFTER a newer one replaced it must not clear the
  // newer, still-valid entry (that would re-burn the budget this cache exists to protect).
  token.catch(() => {
    if (mintedToken?.token === token) mintedToken = null;
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
 * page's subscribes route correctly before any live frame has named a device. A seed and a live
 * frame carry the same truth (the session's device); the seed just arrives earlier.
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
 * Seed decrypted metadata from the registry's persisted blobs (ux Phase 6) — called with the layout's
 * SSR rows so cold loads have titles before any live frame. Cleartext blobs decode synchronously; a
 * CIPHERTEXT blob (E2E daemon) is decrypted with this browser's PERSISTED per-session content key
 * (ux Phase 6 T3), so a title survives a reload even with no daemon and no relay cache. Live meta always
 * wins. Fire-and-forget async: the cheap cleartext seed lands first, decrypted titles fill in after.
 */
export function seedSessionMetas(
  rows: readonly RegistrySessionRow[],
  store: ContentKeyStore | null = defaultContentKeyStore(),
): void {
  // Cheap, key-free path first so cleartext/legacy titles render immediately.
  sessionMetaMap.update((map) => seedRegistryMetas(map, rows));
  if (
    !store ||
    !rows.some((row) => row.sealedMeta !== null && (row.sealedMetaNonce ?? '') !== '')
  ) {
    return;
  }
  const decrypt: SealedMetaDecryptor = (sessionId, payload, nonce) =>
    openSealedWithStoredKey(store, sessionId, payload, nonce);
  void seedRegistryMetasAsync(get(sessionMetaMap), rows, decrypt).then((decrypted) =>
    // A live frame may have landed during decryption — it must still win, so overlay only the ids the
    // CURRENT map lacks (re-read here, not the snapshot the async decode started from).
    sessionMetaMap.update((live) => overlayMissingMetas(live, decrypted)),
  );
}

/**
 * Seed the rename overrides from the registry's persisted `sealed_title` blobs (ux Phase 6 T6) — the exact
 * mirror of {@link seedSessionMetas} for the separate override map, so a rename survives a reload (cleartext
 * synchronously; a ciphertext blob decrypted with this browser's persisted per-session content key). Live
 * `session.title` frames always win. Called alongside `seedSessionMetas` on cold load.
 */
export function seedSessionTitleOverrides(
  rows: readonly RegistrySessionRow[],
  store: ContentKeyStore | null = defaultContentKeyStore(),
): void {
  sessionTitleOverrideMap.update((map) => seedRegistryTitles(map, rows));
  if (
    !store ||
    !rows.some((row) => row.sealedTitle !== null && (row.sealedTitleNonce ?? '') !== '')
  ) {
    return;
  }
  const decrypt: SealedMetaDecryptor = (sessionId, payload, nonce) =>
    openSealedWithStoredKey(store, sessionId, payload, nonce);
  void seedRegistryTitlesAsync(get(sessionTitleOverrideMap), rows, decrypt).then((decrypted) =>
    sessionTitleOverrideMap.update((live) => overlayMissingTitles(live, decrypted)),
  );
}

/** Add only the decrypted metas whose ids the live map doesn't already hold (a live frame wins). */
export function overlayMissingMetas(
  live: SessionMetaMap,
  decrypted: SessionMetaMap,
): SessionMetaMap {
  let merged: Map<string, SessionMetaPayload> | null = null;
  for (const [id, meta] of decrypted) {
    if (live.has(id)) continue;
    merged ??= new Map(live);
    merged.set(id, meta);
  }
  return merged ?? live;
}

/**
 * Wipe every persisted per-session content key (sign-out, ux Phase 6 T3). Enforces the security
 * guarantee that a shared machine can't decrypt this account's sealed titles after sign-out, so a
 * failed wipe is surfaced (not silently swallowed) — the caller still resolves so logout proceeds.
 */
export function clearPersistedContentKeys(
  store: ContentKeyStore | null = defaultContentKeyStore(),
): Promise<void> {
  return (
    store?.clear().catch((err: unknown) => {
      // Surface a security-relevant wipe failure for diagnosis (never silently swallow it).
      console.error('telecode: failed to wipe persisted content keys on sign-out', err);
    }) ?? Promise.resolve()
  );
}

/**
 * Open/refresh the pooled connections if needed, minting channel tokens on demand — on the first
 * connect and on every reconnect, so a token that lapsed during a sleep is renewed (Phase 4 Task 4).
 * Idempotent and browser-only — the layout calls it whenever the device list changes, INCLUDING
 * down to an empty fleet (revoking the last device must tear its channel down). `createConn` is
 * the test seam; production uses the real connection.
 */
export function ensureConnections(
  options: {
    relayUrl: string;
    userId: string;
    devices: readonly PoolDevice[];
  },
  createConn: typeof createRelayConnection = createRelayConnection,
): void {
  connectDevices(
    options.devices,
    {
      relayUrl: options.relayUrl,
      userId: options.userId,
      getChannelToken: fetchChannelToken,
    },
    createConn,
  );
}

/** The launch's target channel: the named device's, or the sole pooled one (never a guess). */
function launchTarget(
  deviceId: string | undefined,
): { deviceId: string; conn: RelayConnection } | null {
  const targetId = deviceId ?? (connections.size === 1 ? [...connections.keys()][0] : undefined);
  const conn = targetId !== undefined ? connections.get(targetId) : undefined;
  return targetId !== undefined && conn ? { deviceId: targetId, conn } : null;
}

/**
 * Await the `session.started` that echoes `clientRef`, resolving with the minted session id (routed to
 * `deviceId` before resolving — the caller navigates to the session view, which subscribes). Shared by
 * {@link launch} and {@link resumeAsNew}: both actions mint their session daemon-side and pair it here.
 */
function awaitSessionStart(
  clientRef: string,
  deviceId: string,
  timeoutMessage: string,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pending: PendingLaunch = {
      clientRef,
      deviceId,
      resolve: (sessionId) => {
        clearTimeout(pending.timer);
        routeSession(sessionId, deviceId);
        resolve(sessionId);
      },
      reject: (error) => {
        clearTimeout(pending.timer);
        reject(error);
      },
      timer: setTimeout(() => {
        const index = pendingLaunches.indexOf(pending);
        if (index >= 0) pendingLaunches.splice(index, 1);
        reject(new Error(timeoutMessage));
      }, LAUNCH_TIMEOUT_MS),
    };
    pendingLaunches.push(pending);
  });
}

/**
 * Launch a session on one device; resolves with the relay-minted id once the daemon reports it
 * started. The target device is explicit — with a fleet there is no "the" device to default to.
 */
export function launch(payload: SessionLaunchPayload, deviceId?: string): Promise<string> {
  const target = launchTarget(deviceId);
  if (!target) {
    return Promise.reject(new Error('Not connected to the relay.'));
  }
  const clientRef = crypto.randomUUID();
  const started = awaitSessionStart(
    clientRef,
    target.deviceId,
    'Launch timed out — is the device online?',
  );
  target.conn.launch({ ...payload, clientRef });
  return started;
}

/**
 * Continue a TERMINAL session as a NEW linked one (ux Phase 6 T8): sends `session.resume_new` on the
 * PARENT's channel; the daemon forks (or fresh-launches) a `session.chained` child whose
 * `session.started` echoes our clientRef — resolves with the child id so the caller can navigate.
 */
export function resumeAsNew(parentSessionId: string, prompt: string): Promise<string> {
  const deviceId = routedDeviceId(parentSessionId);
  const conn = deviceId !== undefined ? connections.get(deviceId) : undefined;
  if (deviceId === undefined || !conn) {
    return Promise.reject(new Error('Not connected to this session’s device.'));
  }
  const clientRef = crypto.randomUUID();
  const started = awaitSessionStart(
    clientRef,
    deviceId,
    'Resume timed out — is the device online?',
  );
  conn.resumeNew(parentSessionId, { prompt, clientRef });
  return started;
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

/**
 * The outcome of a session action (rename/reset, archive/restore/delete): success, or a
 * human-readable reason the UI surfaces inline.
 */
export type SessionActionResult = { ok: true } | { ok: false; error: string };

/** PATCH the rename BFF (which forwards to the relay with the httpOnly token). Ok on 204. */
async function patchSessionTitle(sessionId: string, body: SessionRenameBody): Promise<boolean> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Rename a session (ux Phase 6 T6): seal the title under the session content key (so the relay never reads
 * it), PATCH it, and reflect it immediately in the override map for the actor — the relay also broadcasts
 * `session.title` to every other tab. Only E2E sessions can be renamed (the sealed blob must be real
 * ciphertext); a cleartext session reports that honestly instead of sending a fake one.
 */
export async function renameSession(
  sessionId: string,
  title: string,
): Promise<SessionActionResult> {
  const conn = connectionFor(sessionId);
  if (!conn) return { ok: false, error: 'Not connected to this session’s device.' };
  // Sealing is WebCrypto (can reject); keep it inside the Result contract so the caller never has to catch
  // — an unhandled rejection here would strand the editor's Save button spinning forever.
  let sealed: { payload: string; nonce: string } | null;
  try {
    sealed = await conn.sealTitle(sessionId, title);
  } catch {
    return { ok: false, error: 'Could not encrypt the new name. Please try again.' };
  }
  if (!sealed) {
    return {
      ok: false,
      error: 'Renaming needs an active encrypted session — reopen it and try again.',
    };
  }
  const ok = await patchSessionTitle(sessionId, {
    sealed_title: sealed.payload,
    sealed_title_nonce: sealed.nonce,
  });
  if (!ok) return { ok: false, error: 'Could not save the new name. Please try again.' };
  sessionTitleOverrideMap.update((map) => new Map(map).set(sessionId, title));
  return { ok: true };
}

/** Reset a session's title to the derived default (ux Phase 6 T6): clear the override on the relay + here. */
export async function resetSessionTitle(sessionId: string): Promise<SessionActionResult> {
  const ok = await patchSessionTitle(sessionId, { sealed_title: null });
  if (!ok) return { ok: false, error: 'Could not reset the name. Please try again.' };
  sessionTitleOverrideMap.update((map) => {
    if (!map.has(sessionId)) return map;
    const next = new Map(map);
    next.delete(sessionId);
    return next;
  });
  return { ok: true };
}

/**
 * Drop every trace of one session from the live maps (ux Phase 6 T7, AD-13). After an archive or a
 * delete the registry row disappears from the layout data — but a leftover live entry would make the
 * shared merge resurrect the row as a ghost. Purges live state, meta, rename override, and the route.
 * (The persisted IndexedDB content key stays until sign-out — with the blobs gone there is nothing left
 * to decrypt, and the sign-out wipe already covers it.)
 */
function forgetSession(sessionId: string): void {
  const drop = <V>(map: ReadonlyMap<string, V>): ReadonlyMap<string, V> => {
    if (!map.has(sessionId)) return map;
    const next = new Map(map);
    next.delete(sessionId);
    return next;
  };
  sessionMap.update(drop);
  sessionMetaMap.update(drop);
  sessionChangesMap.update(drop);
  sessionBranchesMap.update(drop);
  sessionTitleOverrideMap.update(drop);
  sessionDeviceMap.update(drop);
}

/** How a worktree-reap request settled (branch-actions T3) — every failure is a retellable reason. */
export type WorkspaceReapOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: WorkspaceReapFailureCode | 'daemon-offline' | 'timeout' | 'no-connection';
    };

/** How a branch-switch request settled (branch-actions T4) — every failure is a retellable reason. */
export type BranchSwitchOutcome =
  | { ok: true; branch: string }
  | {
      ok: false;
      reason: BranchSwitchFailureCode | 'daemon-offline' | 'timeout' | 'no-connection';
    };

/** Every session-keyed ask (reap, switch, …) settles this way when it can't (or can no longer) run. */
type UnstartableOutcome = { ok: false; reason: 'no-connection' };

const DEVICE_RPC_TIMEOUT_MS = 15_000;

/**
 * One in-flight ask per session, settled by exactly one of: the daemon's sealed verdict, the
 * relay's honest device-offline error, the local timeout, or teardown — the shape every
 * session-keyed device RPC shares (reap T3, switch T4, and whatever Phase C adds next). A second
 * ask for the same session SUPERSEDES the first (settled `no-connection`, timer cleared) so a
 * stale timeout can never fire into the new ask's slot.
 */
function createPendingAsks<TOutcome extends { ok: boolean }>(timeoutOutcome: TOutcome) {
  const pending = new Map<
    string,
    {
      resolve: (outcome: TOutcome | UnstartableOutcome) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function settle(sessionId: string, outcome: TOutcome | UnstartableOutcome): void {
    const entry = pending.get(sessionId);
    if (!entry) return;
    pending.delete(sessionId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
  }

  function start(sessionId: string, send: () => void): Promise<TOutcome | UnstartableOutcome> {
    settle(sessionId, { ok: false, reason: 'no-connection' }); // supersede any stale ask
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(sessionId, timeoutOutcome), DEVICE_RPC_TIMEOUT_MS);
      pending.set(sessionId, { resolve, timer });
      send();
    });
  }

  /** Teardown (sign-out): nothing stale survives — every waiter settles now, honestly. */
  function drain(): void {
    for (const sessionId of [...pending.keys()]) {
      settle(sessionId, { ok: false, reason: 'no-connection' });
    }
  }

  return { settle, start, drain };
}

const reapAsks = createPendingAsks<WorkspaceReapOutcome>({ ok: false, reason: 'timeout' });
const switchAsks = createPendingAsks<BranchSwitchOutcome>({ ok: false, reason: 'timeout' });

/**
 * Ask the session's device to remove its worktree + branch (the delete dialog's explicit opt-in,
 * branch-actions T3). Resolves with the daemon's own verdict — the caller decides whether the
 * delete proceeds; this never deletes anything registry-side itself.
 */
export function reapWorkspace(sessionId: string): Promise<WorkspaceReapOutcome> {
  const connection = connectionFor(sessionId);
  if (!connection) return Promise.resolve({ ok: false, reason: 'no-connection' });
  return reapAsks.start(sessionId, () => connection.sendWorkspaceReap(sessionId));
}

/**
 * Ask the session's device to move its worktree onto another existing branch (the rail's Switch
 * control, branch-actions T4). Resolves with the daemon's own verdict — the branch row updates via
 * the daemon's `session.meta` re-emit, never optimistically.
 */
export function switchSessionBranch(
  sessionId: string,
  branch: string,
): Promise<BranchSwitchOutcome> {
  const connection = connectionFor(sessionId);
  if (!connection) return Promise.resolve({ ok: false, reason: 'no-connection' });
  return switchAsks.start(sessionId, () => connection.switchBranch(sessionId, branch));
}

/** Ask the session's device for its repo's branch list (T4); lands in {@link sessionBranches}. */
export function requestSessionBranches(sessionId: string): void {
  connectionFor(sessionId)?.sendRepoBranchesRequest(sessionId);
}

/**
 * Shelve a terminal session via the BFF (ux Phase 6 T7). On success the session is forgotten locally
 * so the board can't resurrect it (AD-13) — the caller re-runs the layout load for the fresh list.
 */
export async function archiveSession(sessionId: string): Promise<SessionActionResult> {
  const outcome = await patchArchived(sessionId, true);
  if (outcome !== 'ok') return failureFor(outcome, 'archive');
  forgetSession(sessionId);
  return { ok: true };
}

/** Bring an archived session back to the board (ux Phase 6 T7). Local state is kept — the row returns. */
export async function restoreSession(sessionId: string): Promise<SessionActionResult> {
  const outcome = await patchArchived(sessionId, false);
  if (outcome !== 'ok') return failureFor(outcome, 'restore');
  return { ok: true };
}

/** Permanently delete a terminal session via the BFF (ux Phase 6 T7); forgets it locally on success. */
export async function deleteSessionForever(sessionId: string): Promise<SessionActionResult> {
  const outcome = await housekeepingRequest(`/api/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
  if (outcome !== 'ok') return failureFor(outcome, 'delete');
  forgetSession(sessionId);
  return { ok: true };
}

type HousekeepingOutcome = 'ok' | 'conflict' | 'failed';

/** The shared archive-flag PATCH behind {@link archiveSession} / {@link restoreSession}. */
function patchArchived(sessionId: string, archived: boolean): Promise<HousekeepingOutcome> {
  return housekeepingRequest(`/api/sessions/${encodeURIComponent(sessionId)}/archive`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ archived }),
  });
}

/** One BFF call, folded to an outcome the actions can message (409 = still running, else failed). */
async function housekeepingRequest(url: string, init: RequestInit): Promise<HousekeepingOutcome> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return 'ok';
    return res.status === 409 ? 'conflict' : 'failed';
  } catch {
    return 'failed';
  }
}

/** Past tenses spelled out — string-built grammar can't misspell a new verb's error message. */
const HOUSEKEEPING_VERBS = {
  archive: 'archived',
  restore: 'restored',
  delete: 'deleted',
} as const;

function failureFor(
  outcome: 'conflict' | 'failed',
  verb: keyof typeof HOUSEKEEPING_VERBS,
): SessionActionResult {
  return {
    ok: false,
    error:
      outcome === 'conflict'
        ? `Only ended sessions can be ${HOUSEKEEPING_VERBS[verb]} — this one is still going.`
        : `Could not ${verb} the session. Please try again.`,
  };
}

/** Ask ONE device's daemon for its adoption policy (Journey 3); the reply lands on {@link adoptStates}. */
export function requestAdoptConfig(deviceId: string): void {
  connections.get(deviceId)?.sendAdoptConfig();
}

/** Update ONE device's adoption policy (sealed); its daemon persists it and echoes {@link adoptStates}. */
export function setAdoptConfig(deviceId: string, settings: AdoptSettings): void {
  connections.get(deviceId)?.sendAdoptConfig(settings);
}

/** Ask ONE device's daemon for its default repo's branches; the reply lands on {@link repoBranches}. */
export function requestRepoBranches(deviceId: string): void {
  connections.get(deviceId)?.sendRepoBranchesRequest();
}

/** Close every pooled connection and reject in-flight launches (only on full teardown, e.g. sign-out). */
export function disconnect(): void {
  for (const pending of pendingLaunches.splice(0)) {
    pending.reject(new Error('Disconnected.'));
  }
  // Session-keyed device asks settle now (no-connection) — nothing waits into the signed-out void.
  reapAsks.drain();
  switchAsks.drain();
  for (const connection of connections.values()) connection.close();
  connections.clear();
  deviceChannelMap.set(new Map());
  sessionDeviceMap.set(new Map());
  // Full teardown (sign-out): drop watched-session state. A later reconnect re-fetches the list from the
  // registry and backfills transcripts, so nothing stale should linger across a disconnect.
  sessionMap.set(new Map());
  adoptStatesMap.set(new Map());
  repoBranchesMap.set(new Map());
  sessionBranchesMap.set(new Map());
  sessionMetaMap.set(new Map());
  sessionTitleOverrideMap.set(new Map());
  sessionChangesMap.set(new Map());
}
