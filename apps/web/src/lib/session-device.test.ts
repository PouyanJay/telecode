import { describe, expect, it } from 'vitest';

import { resolveSessionDevice } from './session-device';

/**
 * Device attribution honesty (honesty pass T5, made fleet-aware in ux Phase 5): the session view
 * must name the device the session actually runs on — from its registry row, or the live routing
 * map for a session launched/streamed this visit — never "the first paired device", which
 * mislabeled every session on a second machine.
 */
const devices = [
  { id: 'dev-1', name: 'macbook' },
  { id: 'dev-2', name: 'mini-server' },
];

describe('resolveSessionDevice', () => {
  it("resolves a registry session's device by its own deviceId, not list order", () => {
    const device = resolveSessionDevice({
      sessionId: 's-on-second',
      sessions: [{ id: 's-on-second', deviceId: 'dev-2' }],
      devices,
    });
    expect(device).toEqual({ id: 'dev-2', name: 'mini-server' });
  });

  it('returns null when the session belongs to a device no longer listed (revoked)', () => {
    const device = resolveSessionDevice({
      sessionId: 's-orphaned',
      sessions: [{ id: 's-orphaned', deviceId: 'dev-gone' }],
      devices,
    });
    expect(device).toBeNull();
  });

  it('resolves a not-yet-persisted session via the LIVE routing map (a fresh launch)', () => {
    const device = resolveSessionDevice({
      sessionId: 's-just-launched',
      sessions: [{ id: 's-other', deviceId: 'dev-2' }],
      devices,
      liveDeviceId: 'dev-2',
    });
    expect(device).toEqual({ id: 'dev-2', name: 'mini-server' });
  });

  it('falls back to the sole paired device when nothing routed the session yet', () => {
    const device = resolveSessionDevice({
      sessionId: 's-unrouted',
      sessions: [],
      devices: [devices[0]!],
    });
    expect(device).toEqual({ id: 'dev-1', name: 'macbook' });
  });

  it('refuses to guess among several devices — null beats a wrong name', () => {
    const device = resolveSessionDevice({
      sessionId: 's-unrouted',
      sessions: [],
      devices,
    });
    expect(device).toBeNull();
  });

  it('returns null when no devices are paired at all', () => {
    const device = resolveSessionDevice({ sessionId: 's-any', sessions: [], devices: [] });
    expect(device).toBeNull();
  });
});
