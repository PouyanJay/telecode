import type { Pool } from 'pg';
import { expect, vi } from 'vitest';

/**
 * Poll the registry until a session row reaches the expected status.
 *
 * A terminal `session.ended` now reaches the watching browser BEFORE the relay persists the status, so the
 * operator sees the run finish without waiting on a DB round-trip (slow on a cold/auto-pausing DB). That
 * makes the registry eventually-consistent with the live stream — so a test that has just observed
 * `session.ended` asserts the persisted status with a short poll rather than a single read that could race
 * the write.
 */
export async function expectSessionStatus(
  admin: Pool,
  sessionId: string | undefined,
  expected: string,
): Promise<void> {
  // Fail fast at the call site rather than as an opaque poll timeout if the id never resolved.
  expect(sessionId, 'expectSessionStatus: sessionId must be defined').toBeDefined();
  await vi.waitFor(
    async () => {
      const row = await admin.query<{ status: string }>(
        'select status from sessions where id = $1',
        [sessionId],
      );
      expect(row.rows[0]?.status).toBe(expected);
    },
    { timeout: 5000, interval: 50 },
  );
}
