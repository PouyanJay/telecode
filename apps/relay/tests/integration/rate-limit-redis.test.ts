import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRelay } from '../../src/relay';

/**
 * Live Redis-backed rate limiting (Phase 5 Task 2). Skipped unless `REDIS_URL` points at a real Redis — the
 * store-selection seam is unit-tested without Redis (`tests/rate-limit-store.test.ts`); this proves the real
 * ioredis store actually enforces the budget end-to-end when an operator runs Redis. A fresh namespace per
 * run keeps it independent of any pre-existing keys.
 */
const REDIS_URL = process.env.REDIS_URL;

describe.skipIf(!REDIS_URL)('Redis-backed rate limiting (live)', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('enforces the budget through the Redis store', async () => {
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      trustProxy: true,
      // Defined here — the suite is skipped above when REDIS_URL is absent.
      rateLimit: { max: 2, timeWindow: 60_000, redisUrl: REDIS_URL! },
    });

    // A unique client IP so the bucket starts empty regardless of prior runs.
    const ip = `198.51.100.${Math.floor((Date.now() % 250) + 1)}`;
    const headers = { 'x-forwarded-for': ip };
    const codes: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({ method: 'GET', url: '/healthz', headers });
      codes.push(res.statusCode);
    }

    expect(codes.slice(0, 2)).toEqual([200, 200]);
    expect(codes[2]).toBe(429);
  });
});
