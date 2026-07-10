import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildRelay } from '../../src/relay';

/**
 * DB keep-alive (free-tier warmth). The relay pings the DB immediately and on an interval so a device-token
 * check on an otherwise-idle free-tier instance doesn't hit a cold-start/timeout and wrongly reject a valid
 * daemon. This restores the incidental DB traffic the old reconnect churn provided — without the churn.
 *
 * Fake timers drive the interval deterministically (no wall-clock races): the immediate ping is asserted
 * BEFORE any tick, and interval ticks are advanced explicitly.
 */
const silent = pino({ level: 'silent' });

describe('relay: DB keep-alive', () => {
  let app: Awaited<ReturnType<typeof buildRelay>> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.useRealTimers();
  });

  it('pings the DB immediately at build time — before any interval elapses', async () => {
    let pings = 0;
    // A long interval that CANNOT have ticked; a ping proves it fired immediately, not on a timer.
    app = await buildRelay({
      logger: silent,
      dbKeepAlive: { ping: async () => void pings++, intervalMs: 60_000 },
    });
    expect(pings).toBe(1);
  });

  it('keeps pinging on the interval after the immediate warm-up', async () => {
    let pings = 0;
    app = await buildRelay({
      logger: silent,
      dbKeepAlive: { ping: async () => void pings++, intervalMs: 1000 },
    });
    expect(pings).toBe(1); // immediate
    await vi.advanceTimersByTimeAsync(3000);
    expect(pings).toBe(4); // + 3 interval ticks
  });

  it('keeps pinging across repeated failures — best-effort, never fatal', async () => {
    let attempts = 0;
    app = await buildRelay({
      logger: silent,
      dbKeepAlive: {
        ping: async () => {
          attempts++;
          throw new Error('database cold/unavailable');
        },
        intervalMs: 1000,
      },
    });
    expect(attempts).toBe(1); // immediate (failed)
    // Every tick retries despite the prior failure — proving the loop isn't torn down by an error.
    await vi.advanceTimersByTimeAsync(3000);
    expect(attempts).toBe(4);
    // ...and the relay is still serving.
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('does not overlap a still-in-flight ping with the next tick', async () => {
    let started = 0;
    let release!: () => void;
    // A ping that never resolves until we release it, so a second tick fires while the first is in flight.
    app = await buildRelay({
      logger: silent,
      dbKeepAlive: {
        ping: () =>
          new Promise<void>((resolve) => {
            started++;
            release = resolve;
          }),
        intervalMs: 1000,
      },
    });
    expect(started).toBe(1); // immediate, now hanging
    await vi.advanceTimersByTimeAsync(3000); // 3 ticks, but the first ping is still in flight
    expect(started).toBe(1); // no overlap — the in-flight guard skipped every tick
    release();
    await vi.advanceTimersByTimeAsync(1000); // next tick after it settles
    expect(started).toBe(2);
  });

  it('does not ping when disabled (intervalMs <= 0)', async () => {
    let pings = 0;
    app = await buildRelay({
      logger: silent,
      dbKeepAlive: { ping: async () => void pings++, intervalMs: 0 },
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings).toBe(0); // no immediate ping, no interval
  });
});
