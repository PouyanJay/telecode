import { createAuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Request body-size cap (Phase 5 Task 3). The relay's HTTP bodies are all tiny JSON (codes, identities), so
 * a small cap rejects oversized payloads before they are buffered or parsed — cheap defense against a
 * memory-pressure flood. Proven against a real route: a body over the limit gets 413, one under it is served.
 */
const DATABASE_URL = process.env.DATABASE_URL;

describe('request body-size cap', () => {
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
      bodyLimit: 1024,
      auth: {
        service: createAuthService({ db: handle, channelTokenSecret: 'chan-secret' }),
        serviceSecret: 'svc-secret-body-test',
      },
      deviceRegistry: createDeviceRegistry(handle),
    });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
  });

  it('rejects a body over the limit with 413 but serves one under it', async () => {
    const oversized = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'x'.repeat(4096) },
    });
    expect(oversized.statusCode).toBe(413);

    const ok = await app.inject({
      method: 'POST',
      url: '/device/code',
      payload: { name: 'laptop' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
