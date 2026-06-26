import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';

/**
 * Walking skeleton (Phase 5 Task 1): the relay's rate-limit seam end-to-end.
 *
 * The relay is the only publicly reachable surface of telecode, so it must be safe to leave running on the
 * open internet. This proves the `rateLimit` option wires `@fastify/rate-limit` globally: once a key (the
 * caller IP, constant under `inject`) exceeds its window budget, further requests get `429` with the
 * standard rate-limit headers — without auth or a database, so the wiring is provable in isolation.
 *
 * The limiter is OFF when the option is absent (every other relay test passes no `rateLimit`), so this
 * file is the only place the behavior is exercised; production turns it on in `main.ts`.
 */
describe('relay rate limiting (walking skeleton)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('returns 429 once a caller exceeds the window budget', async () => {
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      rateLimit: { max: 2, timeWindow: 60_000 },
    });

    const first = await app.inject({ method: 'GET', url: '/healthz' });
    const second = await app.inject({ method: 'GET', url: '/healthz' });
    const third = await app.inject({ method: 'GET', url: '/healthz' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    // The standard advisory headers a well-behaved client backs off on.
    expect(third.headers['retry-after']).toBeDefined();
    expect(third.headers['x-ratelimit-limit']).toBe('2');
    expect(third.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('does not limit when the rateLimit option is absent', async () => {
    app = await buildRelay({ logger: pino({ level: 'silent' }) });

    for (let i = 0; i < 5; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/healthz' });
      expect(res.statusCode).toBe(200);
    }
  });
});
