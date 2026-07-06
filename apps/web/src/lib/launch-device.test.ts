import { describe, expect, it } from 'vitest';

import { buildLaunchDeviceOptions, defaultLaunchDeviceId } from './launch-device';
import type { DeviceChannelState } from './session-store';

/**
 * The launch drawer's device picker (ux Phase 5): pickable options carry honest per-device
 * presence, and the preselected target is the device most likely meant — the sole device, else
 * the first ONLINE one, else the first listed (an offline launch fails honestly via the relay's
 * offline-launch path rather than being unofferable).
 */
const NOW = new Date('2026-07-05T12:00:00Z').getTime();

function channels(entries: Record<string, DeviceChannelState>): Map<string, DeviceChannelState> {
  return new Map(Object.entries(entries));
}

const mac = { id: 'dev-mac', name: 'MacBook Pro', lastSeenAt: new Date(NOW), online: null };
const mini = { id: 'dev-mini', name: 'mini-server', lastSeenAt: null, online: null };

describe('buildLaunchDeviceOptions', () => {
  it('carries each device’s own presence into its option', () => {
    const options = buildLaunchDeviceOptions(
      [mac, mini],
      channels({
        'dev-mac': { connection: 'connected', daemonOnline: true },
        'dev-mini': { connection: 'connected', daemonOnline: false },
      }),
      NOW,
    );
    expect(options).toEqual([
      { id: 'dev-mac', name: 'MacBook Pro', online: true },
      { id: 'dev-mini', name: 'mini-server', online: false },
    ]);
  });

  it('falls back to the REST snapshot before the channels are up', () => {
    const options = buildLaunchDeviceOptions(
      [
        { ...mac, online: true },
        { ...mini, online: false },
      ],
      channels({}),
      NOW,
    );
    expect(options.map((o) => o.online)).toEqual([true, false]);
  });
});

describe('defaultLaunchDeviceId', () => {
  it('preselects the sole device, online or not', () => {
    expect(defaultLaunchDeviceId([{ id: 'only', name: 'only', online: false }])).toBe('only');
  });

  it('preselects the first ONLINE device in a fleet', () => {
    expect(
      defaultLaunchDeviceId([
        { id: 'a', name: 'a', online: false },
        { id: 'b', name: 'b', online: true },
        { id: 'c', name: 'c', online: true },
      ]),
    ).toBe('b');
  });

  it('falls back to the first device when nothing is online', () => {
    expect(
      defaultLaunchDeviceId([
        { id: 'a', name: 'a', online: false },
        { id: 'b', name: 'b', online: false },
      ]),
    ).toBe('a');
  });

  it('returns null for an empty fleet (the drawer shows the pairing prompt instead)', () => {
    expect(defaultLaunchDeviceId([])).toBeNull();
  });
});
