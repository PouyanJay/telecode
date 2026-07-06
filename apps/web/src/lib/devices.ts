import type { Tone } from './session-display';
import type { ConnectionState, DeviceChannelState } from './session-store';
import { relativeTime } from './time';

/**
 * Honest presence for a paired device, the single source for the sidebar device list, the Devices
 * page, and the dashboard's online tally. Every device has its OWN channel (ux Phase 5), so the
 * inputs are that device's channel state plus the REST `online` snapshot the page loaded with.
 * Truth priority: a LIVE claim needs a healthy authenticated channel (daemon presence frames);
 * without one, the relay's page-load snapshot speaks; with neither, we say connecting/offline —
 * never a guess. Pure (clock injected) so it unit-tests without a connection.
 */
export interface DeviceStatusInput {
  readonly lastSeenAt: Date | null;
  /** THIS device's channel state (`idle` when not pooled yet — e.g. the SSR pre-effect window). */
  readonly connection: ConnectionState;
  /**
   * Whether the daemon is present on this device's channel: the relay's `device.presence` signal.
   * `null` while no frame has arrived yet — unknown, not a claim either way.
   */
  readonly daemonOnline: boolean | null;
  /**
   * The relay's `GET /me/devices` snapshot: whether the daemon was on its channel at page load.
   * Older than any live frame (so live wins), `null` against a pre-snapshot relay (deploy skew).
   */
  readonly restOnline: boolean | null;
}

export interface DeviceStatus {
  readonly tone: Tone;
  /** UPPERCASE label for the StatusDot (`ONLINE` / `CONNECTING…` / `OFFLINE`). */
  readonly label: string;
  readonly online: boolean;
  /** Relative last-seen for the row meta ('now' when online, else 'never' / 'N min ago'). */
  readonly lastSeen: string;
}

const ONLINE: Omit<DeviceStatus, 'lastSeen'> = { tone: 'success', label: 'ONLINE', online: true };
const OFFLINE: Omit<DeviceStatus, 'lastSeen'> = { tone: 'muted', label: 'OFFLINE', online: false };
const CONNECTING: Omit<DeviceStatus, 'lastSeen'> = {
  tone: 'warning',
  label: 'CONNECTING…',
  online: false,
};

export function deviceStatus(input: DeviceStatusInput, now: number = Date.now()): DeviceStatus {
  const lastSeen = input.lastSeenAt ? relativeTime(input.lastSeenAt, now) : 'never';
  const withSeen = (base: Omit<DeviceStatus, 'lastSeen'>): DeviceStatus => ({
    ...base,
    lastSeen: base.online ? 'now' : lastSeen,
  });

  // A LIVE presence claim is only valid on a healthy authenticated channel — a frame that predates
  // a dropped socket is not a live claim anymore.
  if (input.connection === 'connected' && input.daemonOnline !== null) {
    return withSeen(input.daemonOnline ? ONLINE : OFFLINE);
  }
  // A failing channel: we can verify nothing right now; claim the conservative state.
  if (input.connection === 'error') {
    return withSeen(OFFLINE);
  }
  // No live signal (yet): the page-load snapshot is the best remaining truth — this is what lets a
  // cold load render who is online before any WebSocket lands.
  if (input.restOnline !== null) {
    return withSeen(input.restOnline ? ONLINE : OFFLINE);
  }
  // Nothing known at all (pre-snapshot relay): while a channel is coming up, say so; else offline.
  if (input.connection === 'connecting' || input.connection === 'connected') {
    return withSeen(CONNECTING);
  }
  return withSeen(OFFLINE);
}

/** A device's channel state out of the pool map — the idle default when it is not pooled yet. */
export function deviceChannelOf(
  channels: ReadonlyMap<string, DeviceChannelState>,
  deviceId: string,
): DeviceChannelState {
  return channels.get(deviceId) ?? { connection: 'idle', daemonOnline: null };
}
