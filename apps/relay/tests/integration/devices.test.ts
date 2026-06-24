import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Task 7 — device targeting. The web tier must learn which paired device a browser should watch so it
 * can connect on the daemon's `(user_id, device_id)` channel. `GET /me/devices` resolves the user from
 * the bearer session token and returns only that user's active devices (RLS-scoped). Real relay + PG.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';

describe('relay device listing: GET /me/devices', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let registry: DeviceRegistry;
  let app: FastifyInstance;

  beforeAll(async () => {
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL is not set — start the DB (supabase start) and load .env');
    }
    await runMigrations(DATABASE_URL);
    handle = createDb(DATABASE_URL);
    admin = new Pool({ connectionString: DATABASE_URL });
    auth = createAuthService({ db: handle, channelTokenSecret: CHANNEL_SECRET });
    registry = createDeviceRegistry(handle);

    app = await buildRelay({
      logger: pino({ level: 'silent' }),
      auth: { service: auth, serviceSecret: SERVICE_SECRET },
      deviceRegistry: registry,
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
  });

  it('returns the authenticated user’s active devices, scoped to that user', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });

    const aliceDeviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'alice-laptop',
      deviceTokenHash: 'hash-a',
    });
    await registry.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: 'hash-b',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: { id: string; name: string }[] }>();
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0]).toMatchObject({ id: aliceDeviceId, name: 'alice-laptop' });
  });

  it('omits revoked devices', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'old-laptop',
      deviceTokenHash: 'hash-old',
    });
    await admin.query('update devices set revoked_at = now() where id = $1', [deviceId]);

    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ devices: unknown[] }>().devices).toHaveLength(0);
  });

  it('rejects a request with no / invalid session token', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/devices' })).statusCode).toBe(401);
    const bad = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.statusCode).toBe(401);
  });
});
