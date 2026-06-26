import { createAuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry } from '../../src/registry/device-registry';
import { PAIRING_CODE_RATE_LIMIT } from '../../src/rate-limit';
import { buildRelay } from '../../src/relay';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Per-route rate limits (Phase 5 Task 2). `/device/code` is the most abusable public endpoint: anyone can
 * flood it to exhaust the in-memory pending-code table. It gets a tight per-route budget, far below the
 * generous global one. This proves the override fires on `/device/code` while a request to another route
 * (`/healthz`) under the same caller is still served — i.e. the limit is per-route, not the global bucket.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('per-route rate limits on abuse-prone endpoints', () => {
  let handle: DbHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      // Global budget far above the per-route cap so any limiting we observe is the route's own.
      rateLimit: { max: 500, timeWindow: 60_000 },
      auth: {
        service: createAuthService({ db: handle, channelTokenSecret: 'chan-secret' }),
        serviceSecret: 'svc-secret-rate-test',
      },
      deviceRegistry: createDeviceRegistry(handle),
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('429s /device/code past its per-route budget while other routes still serve', async () => {
    const budget = PAIRING_CODE_RATE_LIMIT.max;

    const accepted: number[] = [];
    for (let i = 0; i < budget; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/device/code', payload: {} });
      accepted.push(res.statusCode);
    }
    const overBudget = await app.inject({ method: 'POST', url: '/device/code', payload: {} });

    // Every request within the budget is served; the explicit count makes a failure message informative.
    expect(accepted).toEqual(Array<number>(budget).fill(200));
    expect(overBudget.statusCode).toBe(429);

    // The pairing flood did not consume the global budget: a different route under the same caller serves.
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
  });
});
