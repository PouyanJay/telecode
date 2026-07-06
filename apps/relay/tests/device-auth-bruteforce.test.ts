import { describe, expect, it } from 'vitest';

import { createDeviceAuthService } from '../src/device-auth';
import type { DeviceRegistry } from '../src/registry/device-registry';

/**
 * Pairing-code brute-force lockout (Phase 5 Task 3). A `user_code` is short enough to type, so the only
 * thing stopping an authenticated attacker from guessing a victim's pending code (and binding the victim's
 * daemon to their own account) is the huge code space — plus this lockout. After too many invalid approve
 * attempts the approving user is locked out for a window. The service takes an injected clock, so the
 * window logic is proven deterministically without timers.
 */
const registry = {
  createDevice: async () => 'device-id',
} as unknown as DeviceRegistry;

describe('device pairing brute-force lockout', () => {
  it('locks out a user after too many invalid approve attempts, per-user and windowed', async () => {
    let clock = 1_000_000;
    const service = createDeviceAuthService({
      verificationUri: 'http://x/activate',
      registry,
      maxApproveFailures: 3,
      approveFailureWindowMs: 60_000,
      now: () => clock,
    });

    expect(await service.approve('BADX-BADX', 'user-1')).toBe('invalid');
    expect(await service.approve('BADX-BADX', 'user-1')).toBe('invalid');
    expect(await service.approve('BADX-BADX', 'user-1')).toBe('invalid');
    // The budget is spent — further attempts are refused without even checking the code.
    expect(await service.approve('BADX-BADX', 'user-1')).toBe('rate_limited');

    // A different user has an independent budget.
    expect(await service.approve('BADX-BADX', 'user-2')).toBe('invalid');

    // Once the window elapses, the locked-out user may try again.
    clock += 60_001;
    expect(await service.approve('BADX-BADX', 'user-1')).toBe('invalid');
  });

  it('approves a valid code and stays idempotent (a real pairing is never locked out)', async () => {
    const service = createDeviceAuthService({
      verificationUri: 'http://x/activate',
      registry,
      maxApproveFailures: 3,
      approveFailureWindowMs: 60_000,
      now: () => 1,
    });

    const { user_code } = await service.requestCode({});
    expect(await service.approve(user_code, 'user-1')).toBe('approved');
    expect(await service.approve(user_code, 'user-1')).toBe('approved'); // idempotent re-approve
  });
});
