import { deviceChannelOf, deviceStatus } from './devices';
import type { SessionRow } from './session-groups';
import type { DeviceChannelState } from './session-store';

/**
 * Device chips + the board's device filter (ux Phase 5, plan B4): the dashboard scopes to one
 * device via `?device=<id>` — URL-carried so /devices can deep-link it and reload keeps the scope.
 * Pure logic; `DeviceChips.svelte` and the dashboard render it.
 */
export interface DeviceChip {
  /** The device this chip scopes to; null = the "All devices" chip. */
  readonly id: string | null;
  readonly label: string;
  /** Presence for the ●/○ mark; null on the All chip (no single truth to claim). */
  readonly online: boolean | null;
  /** Sessions this chip's board would show (thread rows). */
  readonly count: number;
  /** Of those, how many are blocked waiting on the human — the chip's amber badge. */
  readonly needsYou: number;
}

/** The device fields the chips need (a structural slice of `RelayDevice`). */
interface ChipDevice {
  readonly id: string;
  readonly name: string;
  readonly lastSeenAt: Date | null;
  readonly online: boolean | null;
}

function tally(rows: readonly SessionRow[]): { count: number; needsYou: number } {
  let needsYou = 0;
  for (const row of rows) {
    if (row.status === 'awaiting_input') needsYou += 1;
  }
  return { count: rows.length, needsYou };
}

/** The All chip plus one chip per paired device, each carrying its own presence and counts. */
export function buildDeviceChips(input: {
  readonly devices: readonly ChipDevice[];
  readonly channels: ReadonlyMap<string, DeviceChannelState>;
  readonly rows: readonly SessionRow[];
  readonly now?: number;
}): DeviceChip[] {
  const all = tally(input.rows);
  const chips: DeviceChip[] = [{ id: null, label: 'All devices', online: null, ...all }];
  for (const device of input.devices) {
    const channel = deviceChannelOf(input.channels, device.id);
    const status = deviceStatus(
      {
        lastSeenAt: device.lastSeenAt,
        connection: channel.connection,
        daemonOnline: channel.daemonOnline,
        restOnline: device.online,
      },
      input.now,
    );
    chips.push({
      id: device.id,
      label: device.name,
      online: status.online,
      ...tally(filterRowsByDevice(input.rows, device.id)),
    });
  }
  return chips;
}

/** Scope rows to one device (null = all). An unrouted row shows only on the unfiltered board. */
export function filterRowsByDevice<Row extends { readonly deviceId: string | null }>(
  rows: readonly Row[],
  deviceId: string | null,
): Row[] {
  if (deviceId === null) return [...rows];
  return rows.filter((row) => row.deviceId === deviceId);
}

/**
 * The active filter from the URL. Only a currently-paired device id counts — a stale or foreign
 * `?device=` (revoked device, old link) degrades to the unfiltered board, never to a blank one.
 */
export function deviceFilterFromSearch(
  search: URLSearchParams,
  deviceIds: readonly string[],
): string | null {
  const wanted = search.get('device');
  return wanted !== null && deviceIds.includes(wanted) ? wanted : null;
}

/** The board's href for a device scope (the chips' and /devices rows' link target). */
export function deviceBoardHref(deviceId: string | null): string {
  return deviceId === null ? '/' : `/?device=${encodeURIComponent(deviceId)}`;
}

/** The /devices row summary: "6 sessions · 1 needs you →" (plan B4), pluralized honestly. */
export function deviceBoardLinkText(count: number, needsYou: number): string {
  if (count === 0) return 'No sessions →';
  const sessions = `${count} ${count === 1 ? 'session' : 'sessions'}`;
  if (needsYou === 0) return `${sessions} →`;
  return `${sessions} · ${needsYou} ${needsYou === 1 ? 'needs' : 'need'} you →`;
}
