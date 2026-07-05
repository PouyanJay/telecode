import { describe, expect, it } from 'vitest';

import { resolveSessionDevice } from './session-device';

/**
 * Device attribution honesty (honesty pass T5): the session view must name the device the session
 * actually ran on — resolved from the session's own deviceId — never "the first paired device", which
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

  it('falls back to the watched (first) device for a session not yet in the registry (live launch)', () => {
    const device = resolveSessionDevice({
      sessionId: 's-just-launched',
      sessions: [{ id: 's-other', deviceId: 'dev-2' }],
      devices,
    });
    expect(device).toEqual({ id: 'dev-1', name: 'macbook' });
  });

  it('returns null when no devices are paired at all', () => {
    const device = resolveSessionDevice({ sessionId: 's-any', sessions: [], devices: [] });
    expect(device).toBeNull();
  });
});
