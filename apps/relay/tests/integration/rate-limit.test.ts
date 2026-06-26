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

  it('keys the budget by the forwarded client IP when trustProxy is on', async () => {
    // Behind a reverse proxy every request arrives from the proxy's socket; without trustProxy the per-IP
    // budget would collapse into one global budget for all clients. trustProxy makes `request.ip` the real
    // client (from X-Forwarded-For), so distinct clients get independent budgets.
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      trustProxy: true,
      rateLimit: { max: 1, timeWindow: 60_000 },
    });

    const xff = (ip: string): { 'x-forwarded-for': string } => ({ 'x-forwarded-for': ip });
    const a1 = await app.inject({ method: 'GET', url: '/healthz', headers: xff('203.0.113.1') });
    const a2 = await app.inject({ method: 'GET', url: '/healthz', headers: xff('203.0.113.1') });
    const b1 = await app.inject({ method: 'GET', url: '/healthz', headers: xff('203.0.113.2') });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429); // same client, over budget
    expect(b1.statusCode).toBe(200); // different client, own budget
  });

  it('never limits an allowlisted client IP (the trusted web tier)', async () => {
    // The web tier calls server-to-server endpoints for every user, so its egress IP aggregates all
    // traffic and must be exempt or it would throttle the whole user base.
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      trustProxy: true,
      rateLimit: { max: 1, timeWindow: 60_000, allowList: ['203.0.113.9'] },
    });

    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-forwarded-for': '203.0.113.9' },
      });
      expect(res.statusCode).toBe(200);
    }
  });
});
