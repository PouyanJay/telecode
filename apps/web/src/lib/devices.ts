import type { Tone } from './session-display';
import type { ConnectionState } from './session-store';
import { relativeTime } from './time';

/**
 * Honest presence for a paired device, the single source for the sidebar device list and the Devices
 * page. We only hold a live channel to the *watched* device, so only it can be truly "online" (and only
 * while the connection is up); any other paired device has no live signal, so we report it offline with
 * its last-seen time rather than guess. Pure (clock injected) so it unit-tests without a connection.
 */
export interface DeviceStatusInput {
  readonly lastSeenAt: Date | null;
  /** The device whose channel this browser is watching (the relay multiplexes one at a time). */
  readonly isWatched: boolean;
  readonly connection: ConnectionState;
}

export interface DeviceStatus {
  readonly tone: Tone;
  /** UPPERCASE label for the StatusDot (`ONLINE` / `CONNECTING…` / `OFFLINE`). */
  readonly label: string;
  readonly online: boolean;
  /** Relative last-seen for the row meta ('now' when online, else 'never' / 'N min ago'). */
  readonly lastSeen: string;
}

export function deviceStatus(input: DeviceStatusInput, now: number = Date.now()): DeviceStatus {
  const lastSeen = input.lastSeenAt ? relativeTime(input.lastSeenAt, now) : 'never';

  if (input.isWatched && input.connection === 'connected') {
    return { tone: 'success', label: 'ONLINE', online: true, lastSeen: 'now' };
  }
  if (input.isWatched && input.connection === 'connecting') {
    return { tone: 'warning', label: 'CONNECTING…', online: false, lastSeen };
  }
  return { tone: 'muted', label: 'OFFLINE', online: false, lastSeen };
}
