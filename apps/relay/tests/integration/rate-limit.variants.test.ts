import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';

/**
 * Variant coverage (Phase 5 Task 10) for the rate limiter: the per-IP keying matrix, the allow-list across
 * several IPs, and the advisory-header shape — all over the real Fastify app via `inject`, no DB needed.
 */
describe('rate-limit variants', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const hit = (instance: FastifyInstance, ip: string) =>
    instance.inject({ method: 'GET', url: '/healthz', headers: { 'x-forwarded-for': ip } });

  it.each([['198.51.100.1'], ['198.51.100.2'], ['2001:db8::1']])(
    'gives each client (%s) an independent budget under trustProxy',
    async (ip) => {
      app = await buildRelay({
        logger: pino({ level: 'silent' }),
        trustProxy: true,
        rateLimit: { max: 1, timeWindow: 60_000 },
      });
      expect((await hit(app, ip)).statusCode).toBe(200);
      expect((await hit(app, ip)).statusCode).toBe(429);
    },
  );

  it('never limits any IP on the allow list, while a non-listed IP is limited', async () => {
    const allowed = ['203.0.113.10', '203.0.113.11'];
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      trustProxy: true,
      rateLimit: { max: 1, timeWindow: 60_000, allowList: allowed },
    });

    for (const ip of allowed) {
      for (let i = 0; i < 3; i += 1) {
        expect((await hit(app, ip)).statusCode).toBe(200);
      }
    }
    // A caller not on the list still gets the budget enforced.
    expect((await hit(app, '203.0.113.99')).statusCode).toBe(200);
    expect((await hit(app, '203.0.113.99')).statusCode).toBe(429);
  });

  it('returns the standard advisory headers on the limited response', async () => {
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      trustProxy: true,
      rateLimit: { max: 1, timeWindow: 60_000 },
    });
    await hit(app, '198.51.100.50');
    const limited = await hit(app, '198.51.100.50');

    expect(limited.statusCode).toBe(429);
    for (const header of ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining']) {
      expect(limited.headers[header]).toBeDefined();
    }
    expect(limited.headers['x-ratelimit-remaining']).toBe('0');
  });
});
