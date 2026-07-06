import { describe, expect, it } from 'vitest';

import {
  buildDeviceChips,
  deviceBoardHref,
  deviceBoardLinkText,
  deviceFilterFromSearch,
  filterRowsByDevice,
} from './device-filter';
import type { SessionRow } from './session-groups';
import type { DeviceChannelState } from './session-store';

/**
 * Device chips (ux Phase 5, plan B4): chips scope the whole board to one device — the
 * Device→Sessions hierarchy without restructuring the IA — and /devices rows deep-link the same
 * filtered board. The filter lives in the URL (`?device=`), so it survives reload and is linkable.
 */
const NOW = new Date('2026-07-05T12:00:00Z').getTime();

const mac = { id: 'dev-mac', name: 'MacBook Pro', lastSeenAt: new Date(NOW), online: null };
const mini = { id: 'dev-mini', name: 'mini-server', lastSeenAt: null, online: null };

function channels(entries: Record<string, DeviceChannelState>): Map<string, DeviceChannelState> {
  return new Map(Object.entries(entries));
}

function row(overrides: Partial<SessionRow> & Pick<SessionRow, 'id' | 'deviceId'>): SessionRow {
  return {
    title: null,
    status: 'done',
    deviceName: null,
    origin: 'launched',
    isContinuation: false,
    parentSessionId: null,
    createdAt: new Date(NOW),
    ...overrides,
  };
}

const rows: SessionRow[] = [
  row({ id: 's1', deviceId: 'dev-mac', status: 'running' }),
  row({ id: 's2', deviceId: 'dev-mac', status: 'awaiting_input' }),
  row({ id: 's3', deviceId: 'dev-mini', status: 'done' }),
  row({ id: 's4', deviceId: null }),
];

describe('buildDeviceChips', () => {
  it('builds the All chip plus one presence-marked chip per device with its own counts', () => {
    const chips = buildDeviceChips({
      devices: [mac, mini],
      channels: channels({
        'dev-mac': { connection: 'connected', daemonOnline: true },
        'dev-mini': { connection: 'connected', daemonOnline: false },
      }),
      rows,
      now: NOW,
    });
    expect(chips).toEqual([
      { id: null, label: 'All devices', online: null, count: 4, needsYou: 1 },
      { id: 'dev-mac', label: 'MacBook Pro', online: true, count: 2, needsYou: 1 },
      { id: 'dev-mini', label: 'mini-server', online: false, count: 1, needsYou: 0 },
    ]);
  });
});

describe('filterRowsByDevice', () => {
  it('passes everything through unfiltered (All devices)', () => {
    expect(filterRowsByDevice(rows, null)).toEqual(rows);
  });

  it('scopes the board to one device', () => {
    expect(filterRowsByDevice(rows, 'dev-mac').map((r) => r.id)).toEqual(['s1', 's2']);
  });

  it('a device-less row (unrouted) appears only on the unfiltered board', () => {
    expect(filterRowsByDevice(rows, 'dev-mini').map((r) => r.id)).toEqual(['s3']);
  });
});

describe('deviceFilterFromSearch', () => {
  const ids = ['dev-mac', 'dev-mini'];

  it('reads a valid ?device= id', () => {
    expect(deviceFilterFromSearch(new URLSearchParams('device=dev-mini'), ids)).toBe('dev-mini');
  });

  it('treats an absent or unknown id as unfiltered — a stale link never blanks the board', () => {
    expect(deviceFilterFromSearch(new URLSearchParams(''), ids)).toBeNull();
    expect(deviceFilterFromSearch(new URLSearchParams('device=dev-gone'), ids)).toBeNull();
  });
});

describe('deviceBoardHref / deviceBoardLinkText', () => {
  it('links the unfiltered and filtered board', () => {
    expect(deviceBoardHref(null)).toBe('/');
    expect(deviceBoardHref('dev-mini')).toBe('/?device=dev-mini');
  });

  it('summarizes a device’s board with pluralized counts', () => {
    expect(deviceBoardLinkText(6, 1)).toBe('6 sessions · 1 needs you →');
    expect(deviceBoardLinkText(1, 0)).toBe('1 session →');
    expect(deviceBoardLinkText(0, 0)).toBe('No sessions →');
    expect(deviceBoardLinkText(3, 2)).toBe('3 sessions · 2 need you →');
  });
});
