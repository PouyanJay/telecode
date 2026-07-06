import type { AddressInfo } from 'node:net';

import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthService, type AuthService } from '../../src/auth/auth-service';
import { createDb, type DbHandle } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { hashDeviceToken } from '../../src/device-auth';
import { createDeviceRegistry, type DeviceRegistry } from '../../src/registry/device-registry';
import { buildRelay } from '../../src/relay';
import { connectDaemon } from '../_helpers/ws';

/**
 * REST presence snapshot (ux Phase 5): `GET /me/devices` reports each device's LIVE `online` state
 * from the relay's in-memory daemon channels, so a cold page load renders honest presence before
 * any WebSocket lands (the per-channel `device.presence` frames then keep it current). Real relay +
 * Postgres + a real daemon WS.
 */
const DATABASE_URL = process.env.DATABASE_URL;
const SERVICE_SECRET = 'svc-secret-test';
const CHANNEL_SECRET = 'channel-secret-test';
const DEVICE_TOKEN = 'dt_presence-snapshot-token';

describe('relay device presence snapshot: GET /me/devices online', () => {
  let handle: DbHandle;
  let admin: Pool;
  let auth: AuthService;
  let registry: DeviceRegistry;
  let app: FastifyInstance;
  let relayUrl: string;

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
    relayUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query('truncate table users restart identity cascade');
  });

  async function listedOnline(token: string): Promise<Map<string, boolean>> {
    const res = await app.inject({
      method: 'GET',
      url: '/me/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ devices: { id: string; online: boolean }[] }>();
    return new Map(body.devices.map((d) => [d.id, d.online]));
  }

  it('reports online for a device whose daemon is on the channel, false for the rest', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const liveId = await registry.createDevice({
      userId: alice.userId,
      name: 'live-laptop',
      deviceTokenHash: hashDeviceToken(DEVICE_TOKEN),
    });
    const dustyId = await registry.createDevice({
      userId: alice.userId,
      name: 'dusty-mini',
      deviceTokenHash: 'hash-dusty',
    });

    // Before any daemon connects, both are offline.
    const cold = await listedOnline(alice.token);
    expect(cold.get(liveId)).toBe(false);
    expect(cold.get(dustyId)).toBe(false);

    // The live device's daemon registers → only IT flips online in the snapshot.
    const daemon = await connectDaemon(relayUrl, alice.userId, liveId, DEVICE_TOKEN);
    const warm = await listedOnline(alice.token);
    expect(warm.get(liveId)).toBe(true);
    expect(warm.get(dustyId)).toBe(false);

    daemon.close();
  });

  it('flips back to offline once the daemon disconnects', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const deviceId = await registry.createDevice({
      userId: alice.userId,
      name: 'flappy-laptop',
      deviceTokenHash: hashDeviceToken(DEVICE_TOKEN),
    });

    const daemon = await connectDaemon(relayUrl, alice.userId, deviceId, DEVICE_TOKEN);
    expect((await listedOnline(alice.token)).get(deviceId)).toBe(true);

    daemon.close();
    // The relay's close handler deregisters the channel; poll for the snapshot to catch up.
    await expect
      .poll(async () => (await listedOnline(alice.token)).get(deviceId), { timeout: 3000 })
      .toBe(false);
  });

  it('never claims another user’s presence (scoped to the owner’s devices only)', async () => {
    const alice = await auth.createSession({ provider: 'dev', providerUserId: 'alice' });
    const bob = await auth.createSession({ provider: 'dev', providerUserId: 'bob' });
    const bobDeviceId = await registry.createDevice({
      userId: bob.userId,
      name: 'bob-laptop',
      deviceTokenHash: hashDeviceToken(DEVICE_TOKEN),
    });
    const bobDaemon = await connectDaemon(relayUrl, bob.userId, bobDeviceId, DEVICE_TOKEN);

    // Alice's list simply does not contain Bob's device — online or not.
    const aliceView = await listedOnline(alice.token);
    expect(aliceView.has(bobDeviceId)).toBe(false);

    bobDaemon.close();
  });
});
