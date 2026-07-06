import { describe, expect, it } from 'vitest';

import { createDeviceAuthService } from '../src/device-auth';
import { fakeDeviceRegistry } from './_helpers/fake-device-registry';

/**
 * `pendingRestoreDeviceIds` — the in-memory "awaiting re-authorization" signal. It must track only
 * live, unapproved grants that carry VERIFIED restore evidence: expiry hides them (the pairing code
 * is useless past its TTL) and approval consumes them (the device is active again). Injected clock,
 * fake registry — this is the service's own bookkeeping, not the DB's. Also proves the concurrent
 * double-approve of a restore grant: every caller reports the ONE real bind, never a second row.
 */
const REVOKED_DEVICE = { id: 'device-1', userId: 'user-1', name: 'mbp', revokedAt: new Date(1) };

const withRevokedDevice = () =>
  fakeDeviceRegistry({ findRevokedByTokenHash: async () => ({ ...REVOKED_DEVICE }) });

describe('device-auth pending restore tracking', () => {
  it('tracks a verified pending restore, hides it on expiry, and consumes it on approval', async () => {
    let clock = 1_000_000;
    const service = createDeviceAuthService({
      verificationUri: 'http://x/activate',
      registry: withRevokedDevice(),
      expiresInMs: 60_000,
      now: () => clock,
    });

    // No grants yet.
    expect(service.pendingRestoreDeviceIds()).toEqual([]);

    // A verified restore request appears...
    await service.requestCode({ priorDeviceToken: 'dt_prior' });
    expect(service.pendingRestoreDeviceIds()).toEqual(['device-1']);

    // ...and disappears with its pairing code's TTL.
    clock += 60_001;
    expect(service.pendingRestoreDeviceIds()).toEqual([]);

    // A fresh request that gets APPROVED stops being "pending" immediately.
    const approved = await service.requestCode({ priorDeviceToken: 'dt_prior' });
    expect(service.pendingRestoreDeviceIds()).toEqual(['device-1']);
    await service.approve(approved.user_code, 'user-1');
    expect(service.pendingRestoreDeviceIds()).toEqual([]);
  });

  it('never tracks plain pairings or unverifiable evidence', async () => {
    const service = createDeviceAuthService({
      verificationUri: 'http://x/activate',
      registry: fakeDeviceRegistry(), // findRevokedByTokenHash → null: nothing verifies
      now: () => 1,
    });

    await service.requestCode({ name: 'plain' });
    await service.requestCode({ name: 'noise', priorDeviceToken: 'dt_unknown' });
    expect(service.pendingRestoreDeviceIds()).toEqual([]);
  });
});

describe('concurrent duplicate approve of a restore grant', () => {
  it('binds exactly once and reports the SAME restore outcome to every caller', async () => {
    // Hold the DB bind open so the duplicate approve provably lands mid-flight.
    let releaseBind: (() => void) | undefined;
    const bindGate = new Promise<void>((resolve) => {
      releaseBind = resolve;
    });
    let restoreCalls = 0;
    const service = createDeviceAuthService({
      verificationUri: 'http://x/activate',
      registry: fakeDeviceRegistry({
        findRevokedByTokenHash: async () => ({ ...REVOKED_DEVICE }),
        restoreDevice: async () => {
          restoreCalls += 1;
          await bindGate;
          return true;
        },
      }),
      now: () => 1,
    });
    const { user_code } = await service.requestCode({ name: 'mbp', priorDeviceToken: 'dt_prior' });

    const first = service.approve(user_code, 'user-1');
    const duplicate = service.approve(user_code, 'user-1'); // lands while the bind is in flight
    releaseBind?.();

    const results = await Promise.all([first, duplicate]);
    for (const result of results) {
      expect(result).toEqual({ outcome: 'approved', restored: true, deviceName: 'mbp' });
    }
    expect(restoreCalls).toBe(1); // one bind, no second device row
  });
});
