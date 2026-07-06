import type { DeviceRegistry } from '../../src/registry/device-registry';

/**
 * A minimal in-memory stand-in for {@link DeviceRegistry} in unit tests of the device-auth service.
 * Only the methods the grant flow touches are implemented; the rest throw loudly on first use so a
 * widening dependency fails the test instead of silently returning `undefined` (the failure mode of
 * the old per-file `as unknown as DeviceRegistry` casts this replaces).
 */
export function fakeDeviceRegistry(overrides: Partial<DeviceRegistry> = {}): DeviceRegistry {
  const unimplemented = (method: string) => (): never => {
    throw new Error(`fakeDeviceRegistry: ${method} not implemented for this test`);
  };
  const base: DeviceRegistry = {
    createDevice: async () => 'fresh-device',
    findActiveByTokenHash: unimplemented('findActiveByTokenHash'),
    findRevokedByTokenHash: async () => null,
    touchLastSeen: unimplemented('touchLastSeen'),
    findActiveByUser: unimplemented('findActiveByUser'),
    findRevokedByUser: unimplemented('findRevokedByUser'),
    revoke: unimplemented('revoke'),
    rename: unimplemented('rename'),
    restoreDevice: async () => true,
  };
  return { ...base, ...overrides };
}
